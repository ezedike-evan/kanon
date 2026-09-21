import { AiChatScreen } from './ai-chat';

/**
 * 02 · CHAT-TO-SPEC COMPILER.
 *
 * The compiler is the strategy AI's conversation, so it is the same screen as
 * the AI tab (`/create`) and mounts at `/compile` for the places that still
 * link there (onboarding hands its first rule over to it).
 */
export function CompilerScreen() {
  return <AiChatScreen />;
}
