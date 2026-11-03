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
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
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

const app = new App();
const stack = new RowpackDistributedStack(app, 'RowpackDistributed', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1' },
});
Tags.of(stack).add('project', 'rowpack-distributed');
