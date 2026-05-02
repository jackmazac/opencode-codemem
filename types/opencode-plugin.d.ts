declare module "@opencode-ai/plugin" {
  import { z } from "zod";

  export type ToolContext = {
    sessionID: string;
    messageID: string;
    agent: string;
    directory: string;
    worktree: string;
    abort: AbortSignal;
    metadata(input: { title?: string; metadata?: Record<string, any> }): void;
    ask(input: {
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, any>;
    }): Promise<void>;
  };

  export type ToolResult = string | { output: string; metadata?: Record<string, any> };

  export type ToolDefinition = ReturnType<typeof tool>;

  export function tool(input: {
    description: string;
    args: any;
    execute(args: any, context: ToolContext): Promise<ToolResult>;
  }): {
    description: string;
    args: any;
    execute(args: any, context: ToolContext): Promise<ToolResult>;
  };

  export namespace tool {
    const schema: typeof z;
  }

  export type PluginInput = {
    client: any;
    project: { id: string; path?: string };
    directory: string;
    worktree: string;
    experimental_workspace: {
      register(input: { name: string; description?: string }): Promise<void>;
    };
    serverUrl: string;
    $?: any;
  };

  export type Hooks = {
    event?: (input: { event: any }) => Promise<void>;
    tool?: Record<string, ToolDefinition>;
    "chat.message"?: (input: {
      sessionID: string;
      agent?: string;
      model?: string;
      messageID?: string;
      variant?: string;
    }) => Promise<{ message: any; parts: any[] }>;
    "chat.params"?: (input: {
      sessionID: string;
      agent: string;
      model: string;
      provider: string;
      message: string;
    }) => Promise<{
      temperature?: number;
      topP?: number;
      topK?: number;
      maxOutputTokens?: number;
      options?: Record<string, any>;
    }>;
    "permission.ask"?: (
      input: any,
      output: { status: "ask" | "deny" | "allow" },
    ) => Promise<void>;
    "tool.execute.before"?: (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => Promise<void>;
    "tool.execute.after"?: (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title?: string; output?: string; metadata?: Record<string, any> },
    ) => Promise<void>;
    "experimental.session.compacting"?: (input: { sessionID: string }) => Promise<{
      context: string[];
      prompt?: string;
    }>;
  };

  export type PluginOptions = Record<string, unknown>;
  export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
}
