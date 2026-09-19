export interface McpServerConfig {
  readonly name: string;
  readonly url: string;
  readonly description: string;
}

export type McpServersConfig = readonly McpServerConfig[];
