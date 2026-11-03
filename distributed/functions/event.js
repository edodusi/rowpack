// Classic Lambda (an Event Function): one invocation, one environment, one batch.
import { compileBatch } from './compile.js';

let invocations = 0;
const coldAt = Date.now();

export const handler = async (event) => {
  invocations++;
  return { ...compileBatch(event.modules, event.format), environment: { coldAt, invocations } };
};
