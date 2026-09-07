import { PulseSubagent, SubagentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSubagent = PulseSubagent;
export type ProjectionSubagent = typeof ProjectionSubagent.Type;
export const GetProjectionSubagentInput = Schema.Struct({
  subagentId: SubagentId,
});
export type GetProjectionSubagentInput = typeof GetProjectionSubagentInput.Type;
export const ListProjectionSubagentsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionSubagentsInput = typeof ListProjectionSubagentsInput.Type;

export interface ProjectionSubagentRepositoryShape {
  readonly upsert: (subagent: ProjectionSubagent) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionSubagentInput,
  ) => Effect.Effect<Option.Option<ProjectionSubagent>, ProjectionRepositoryError>;
  readonly listByParentThreadId: (
    input: ListProjectionSubagentsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionSubagent>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionSubagent>,
    ProjectionRepositoryError
  >;
}
export class ProjectionSubagentRepository extends Context.Service<
  ProjectionSubagentRepository,
  ProjectionSubagentRepositoryShape
>()("@sats-lab/pulse/persistence/Services/ProjectionSubagents/ProjectionSubagentRepository") {}
