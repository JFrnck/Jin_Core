import { join } from 'node:path';
import { Module, type OnModuleInit } from '@nestjs/common';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { McpClientService } from './mcp-client.service';
import { loadMcpServersConfig } from './mcp-config.schema';
import { MCP_SERVERS_CONFIG } from './mcp.tokens';
import type { McpServersConfig } from './mcp.types';

const MCP_SERVERS_CONFIG_PATH = join(
  process.cwd(),
  'config',
  'mcp-servers.yaml',
);

@Module({
  imports: [HitlModule],
  providers: [
    {
      provide: MCP_SERVERS_CONFIG,
      useFactory: (): McpServersConfig =>
        loadMcpServersConfig(MCP_SERVERS_CONFIG_PATH),
    },
    McpClientService,
  ],
  exports: [McpClientService],
})
export class McpModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly mcpClientService: McpClientService,
  ) {}

  onModuleInit(): void {
    // Registrar ejecutor para `queryExternalDocs` (src/tools/registry.ts).
    // Devuelve texto plano -- `AgentService.handleRealToolCall` ya lo
    // pasa por `wrapUntrustedContent` como a cualquier otra tool (mismo
    // pipeline, sin código nuevo ahí), porque el contenido de un
    // servidor MCP es tan externo como un correo o una página.
    this.toolExecutorRegistry.register('queryExternalDocs', async (payload) => {
      const { library, query } = payload as { library: string; query: string };
      return this.mcpClientService.queryDocs(library, query);
    });
  }
}
