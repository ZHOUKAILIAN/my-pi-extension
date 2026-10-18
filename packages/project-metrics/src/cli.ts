#!/usr/bin/env node
import { flushMetricQueue, metricsStatus, queryMetricStats, statsFailureCode } from './client.ts';
const [command,...args]=process.argv.slice(2);
try {
 let result:unknown;
 if(command==='flush') { const retry=args.length===1&&args[0]==='--retry-failed'; if(args.length&&!retry)throw new Error('invalid_argument'); result=await flushMetricQueue(retry); }
 else if(command==='status') result=await metricsStatus();
 else if(command==='stats') { let days=7, dataset: 'live'|'validation'='live'; for(let i=0;i<args.length;i++){if(args[i]==='--days'){const value=args[++i];if(value===undefined)throw new Error('invalid_argument');days=Number(value);}else if(args[i]==='--validation')dataset='validation';else throw new Error('invalid_argument');} result=await queryMetricStats(days,dataset); }
 else throw new Error('usage: metrics <stats [--days 1..31] [--validation]|flush [--retry-failed]|status>');
 process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
} catch (error) {
 const code = command === 'stats' ? statsFailureCode(error) : null;
 process.stderr.write(`metrics command failed${code ? ` (${code})` : ''}; inspect private configuration and local status\n`);
 process.exitCode=1;
}
