import type { CommandContext, MissionCommand } from "./mission-commands";
import { buildCollaborationCommands, parseCollaborationDirectives } from "./mission-collaboration-bridge";
import type { ExecutionOutcome, ExecutionRecord } from "./mission-execution";
import type { DispatchInstruction } from "./mission-scheduler-store";

export interface MissionCollaborationCommandPort {
  /** Must route through the existing durable Mission command boundary. */
  run(input: { command: MissionCommand; context: CommandContext; idempotencyKey: string; workspaceId: string }): Promise<{ ok: boolean }>;
}

export interface MissionCollaborationResultInput {
  instruction: DispatchInstruction;
  execution: ExecutionRecord;
  outcome: ExecutionOutcome;
  now: string;
}

/**
 * Applies only the collaboration directives explicitly emitted in an already
 * redacted provider summary. It never interprets ordinary prose as a Mission
 * command, and every generated command still goes through the durable command
 * port with deterministic idempotency keys.
 */
export class MissionCollaborationResultBridge {
  private readonly commandPort: MissionCollaborationCommandPort;

  constructor(commandPort: MissionCollaborationCommandPort) {
    this.commandPort = commandPort;
  }

  async apply(input: MissionCollaborationResultInput): Promise<{ commands: number; parseErrors: number }> {
    const participantId = typeof input.instruction.executionConstraints.participantId === "string" ? input.instruction.executionConstraints.participantId : null;
    if (!participantId) return { commands: 0, parseErrors: 0 };

    const parsed = parseCollaborationDirectives(input.outcome.summary);
    if (parsed.directives.length === 0) return { commands: 0, parseErrors: parsed.parseErrors.length };
    const assignmentId = input.instruction.assignmentId ?? (typeof input.instruction.executionConstraints.assignmentId === "string" ? input.instruction.executionConstraints.assignmentId : null);
    const commands = buildCollaborationCommands({
      missionId: input.instruction.missionId,
      assignmentId,
      senderParticipantId: participantId,
      directives: parsed.directives,
      originatingExecutionRef: input.execution.executionId,
    });
    const context: CommandContext = {
      actor: { kind: "agent", id: participantId },
      timestamp: input.now,
      correlationId: `execution:${input.instruction.instructionId}:collaboration`,
      causationId: input.execution.executionId,
    };
    for (const [index, command] of commands.entries()) {
      const result = await this.commandPort.run({
        command,
        context,
        idempotencyKey: `execution-collaboration:${input.execution.executionId}:${index}`,
        workspaceId: input.execution.workspaceId,
      });
      if (!result.ok) throw new Error(`Mission collaboration command refused: ${command.type}`);
    }
    return { commands: commands.length, parseErrors: parsed.parseErrors.length };
  }
}
