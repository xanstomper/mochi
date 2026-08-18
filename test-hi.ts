import { Runtime } from './src/index.js';
import { resolve } from 'node:path';

async function main() {
  const runtime = Runtime.create({ cwd: resolve(process.cwd()) });
  runtime.events.onAll((event) => {
    if (event.type === 'message:chunk') {
      process.stdout.write((event as any).content);
    } else if (event.type === 'tool:called') {
      console.log(`\nTOOL CALLED: ${event.tool}(${JSON.stringify((event as any).args)})\n`);
    } else if (event.type === 'message' && event.role === 'assistant') {
      console.log(`\nASSISTANT: ${event.content}\n`);
    } else if (event.type === 'task:completed') {
      console.log(`\nTASK COMPLETED: ${(event as any).task.output}\n`);
    }
  });

  const res = await runtime.runPrompt('hi');
  console.log('\nDONE:', res);
}

main().catch(console.error);
