import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { ExecutorClientModule } from './executor-client.module';
import type { ExecutorClientService } from './executor-client.service';

describe('ExecutorClientModule', () => {
  it('registra el executor de runCode en ToolExecutorRegistry al iniciar', async () => {
    const registry = new ToolExecutorRegistry();
    const executorClientService: Partial<ExecutorClientService> = {
      runCode: vi.fn().mockResolvedValue({
        runId: 'run-1',
        succeeded: true,
        logs: 'ok',
      }),
    };

    const module = new ExecutorClientModule(
      registry,
      executorClientService as ExecutorClientService,
    );
    module.onModuleInit();

    const result = await registry.execute('runCode', {
      code: 'console.log(1)',
      language: 'typescript',
    });

    expect(result).toEqual({ runId: 'run-1', succeeded: true, logs: 'ok' });
    expect(executorClientService.runCode).toHaveBeenCalledWith({
      code: 'console.log(1)',
      language: 'typescript',
    });
  });
});
