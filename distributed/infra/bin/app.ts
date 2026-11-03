// rowpack, distributed: the same compile code behind three front doors.
//
//   rowpack-compile          a classic Lambda (Event Function), invoked with the SDK
//   rowpack-web-1thread      a Lambda Web Function, one thread per environment
//   rowpack-web-pool         a Lambda Web Function, a worker thread per vCPU
//
// Both Web Function endpoints use IamAuth: only SigV4-signed requests from
// this account get in. Nothing here is publicly reachable.
//
// Web Functions have L1 constructs only (CfnWebFunction, CfnWebFunctionRevision,
// CfnWebFunctionEndpoint), so the role and code bucket are wired by hand,
// as in the freedoom-lambda-web-functions demo.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

// Caps that bound the bill if a benchmark loop runs away.
const MAX_ENVIRONMENTS = 64; // per Web Function endpoint; each environment is 2 vCPUs
const RESERVED_CONCURRENCY = 512; // for the classic function

class RowpackDistributedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- classic Lambda ------------------------------------------------------
    const classicLogs = new logs.LogGroup(this, 'CompileLogs', {
      logGroupName: '/aws/lambda/rowpack-compile',
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const classic = new lambda.Function(this, 'Compile', {
      functionName: 'rowpack-compile',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1769, // one full vCPU
      timeout: Duration.seconds(30),
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(DIST, 'event')),
      reservedConcurrentExecutions: RESERVED_CONCURRENCY,
      logGroup: classicLogs,
    });

    // ---- Web Functions ---------------------------------------------------------
    const role = new iam.Role(this, 'WebExecutionRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/rowpack-*`,
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/rowpack-*:*`,
      ],
    }));

    // The Web Functions service reads the package as lambda.amazonaws.com, so the
    // bucket grants it read access, for this account only.
    // Web Function revisions reference the object by version, so versioning is required
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    codeBucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [codeBucket.arnForObjects('*')],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));
    const upload = new s3deploy.BucketDeployment(this, 'UploadWebCode', {
      sources: [s3deploy.Source.asset(path.join(DIST, 'web'))],
      destinationBucket: codeBucket,
      extract: false,
      prune: false,
    });
    const codeKey = Fn.select(0, upload.objectKeys);

    for (const [suffix, threads] of [['1thread', '1'], ['pool', 'auto']] as const) {
      const name = `rowpack-web-${suffix}`;
      const logGroup = new logs.LogGroup(this, `Logs-${suffix}`, {
        logGroupName: `/aws/lambda/web/${name}`,
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const fn = new lambda.CfnWebFunction(this, `Web-${suffix}`, { functionName: name });
      const revision = new lambda.CfnWebFunctionRevision(this, `Revision-${suffix}`, {
        functionName: fn.functionName,
        buildConfig: {
          runtimeConfig: { runtime: 'nodejs24.x' },
          codeConfig: { s3Object: { bucket: upload.deployedBucket.bucketName, key: codeKey } },
        },
        serviceConfig: {
          executionRoleArn: role.roleArn,
          timeoutSeconds: 30,
          environmentVariables: { THREADS: threads },
          telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName } },
        },
      });
      revision.addDependency(fn);
      revision.node.addDependency(role, upload);

      const endpoint = new lambda.CfnWebFunctionEndpoint(this, `Endpoint-${suffix}`, {
        functionName: fn.functionName,
        endpointName: 'bench',
        endpointType: 'HomeRegion',
        authType: 'IamAuth',
        revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
        scalingConfig: { maxEnvironments: MAX_ENVIRONMENTS },
      });
      endpoint.addDependency(fn);
      new CfnOutput(this, `Domain-${suffix}`, { value: endpoint.attrDomainName });
    }

    new CfnOutput(this, 'CompileFunction', { value: classic.functionName });
  }
}

// rowpack-serve: a public website whose JavaScript is bundled on the first visit.
//
//   CloudFront ──/──────────> Web Function rowpack-serve (IamAuth, signed by CloudFront OAC)
//              └─/builds/*──> S3 site bucket (OAC): the bundles it produced
//   rowpack-serve ──> classic Lambda rowpack-serve-compile ──> object files in the same bucket
//
// The Web Function endpoint only accepts SigV4 requests, so the public way in is
// CloudFront. The resource policy that lets CloudFront sign is attached after
// deploy by serve-deploy.sh (it needs the distribution ARN, and CloudFormation
// has no resource for Web Function policies yet).
class RowpackServeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const name = 'rowpack-serve';

    const site = new s3.Bucket(this, 'Site', {
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ prefix: 'locks/', expiration: Duration.days(1) }],
    });

    const compile = new lambda.Function(this, 'Compile', {
      functionName: `${name}-compile`,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1769,
      timeout: Duration.seconds(30),
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(DIST, 'event')),
      reservedConcurrentExecutions: 64,
      logGroup: new logs.LogGroup(this, 'CompileLogs', { logGroupName: `/aws/lambda/${name}-compile`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    });

    const role = new iam.Role(this, 'ServeRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/${name}*`,
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/lambda/web/${name}*:*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [site.arnForObjects('objects/*'), site.arnForObjects('builds/*'), site.arnForObjects('locks/*')] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [site.bucketArn] })); // so a missing key is 404, not 403
    compile.grantInvoke(role);

    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    codeBucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [codeBucket.arnForObjects('*')],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));
    const upload = new s3deploy.BucketDeployment(this, 'UploadServeCode', {
      sources: [s3deploy.Source.asset(path.join(DIST, 'serve'))],
      destinationBucket: codeBucket,
      extract: false,
      prune: false,
      memoryLimit: 1024,
    });

    const logGroup = new logs.LogGroup(this, 'ServeLogs', { logGroupName: `/aws/lambda/web/${name}`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const fn = new lambda.CfnWebFunction(this, 'Serve', { functionName: name });
    const revision = new lambda.CfnWebFunctionRevision(this, 'ServeRevision', {
      functionName: fn.functionName,
      buildConfig: {
        runtimeConfig: { runtime: 'nodejs24.x' },
        codeConfig: { s3Object: { bucket: upload.deployedBucket.bucketName, key: Fn.select(0, upload.objectKeys) } },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: 120,
        environmentVariables: { BUCKET: site.bucketName, COMPILE_FUNCTION: compile.functionName },
        telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName } },
      },
    });
    revision.addDependency(fn);
    revision.node.addDependency(role, upload);
    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'ServeEndpoint', {
      functionName: fn.functionName,
      endpointName: 'live',
      endpointType: 'HomeRegion',
      authType: 'IamAuth',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: 2 }, // the minimum: also the cap on idle memory cost
      throttleConfig: { rateLimit: 100 },
    });
    endpoint.addDependency(fn);

    // CloudFront: the page from the Web Function, the bundles from S3
    const oac = new cloudfront.CfnOriginAccessControl(this, 'ServeOac', {
      originAccessControlConfig: { name: `${name}-oac`, originAccessControlOriginType: 'lambda', signingBehavior: 'always-amz-auth', signingProtocol: 'sigv4' },
    });
    const pagePolicy = new cloudfront.CachePolicy(this, 'PageCache', {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0), // the origin says: no-store while building, 60 s once built
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'rowpack-serve: bundled on first visit',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.HttpOrigin(endpoint.attrDomainName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, readTimeout: Duration.seconds(60) }),
        cachePolicy: pagePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/builds/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(site),
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
      },
    });
    // attach the Lambda OAC to the Web Function origin (the first origin)
    (distribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);

    new CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionArn', { value: `arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}` });
    new CfnOutput(this, 'WebFunctionArn', { value: fn.attrFunctionArn });
    new CfnOutput(this, 'EndpointArn', { value: endpoint.attrEndpointArn });
    new CfnOutput(this, 'EndpointDomain', { value: endpoint.attrDomainName });
    new CfnOutput(this, 'SiteBucket', { value: site.bucketName });
  }
}

const app = new App();
// the CDK CLI fills CDK_DEFAULT_REGION from the profile, so the Region is its own variable
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.ROWPACK_REGION ?? 'eu-west-1' };
const stack = new RowpackDistributedStack(app, 'RowpackDistributed', { env });
Tags.of(stack).add('project', 'rowpack-distributed');
const serve = new RowpackServeStack(app, 'RowpackServe', { env });
Tags.of(serve).add('project', 'rowpack-serve');
