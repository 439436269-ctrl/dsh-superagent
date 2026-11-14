/** The tools a reviewer Session works with: reading this ticket's context, and no way to act on the ticket. */
import type { Ticket } from '../../core/index.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import { readTool, type Tool } from './tool.ts'

export interface ReviewerToolsHost {
  /** The reads `orchestrator_read` serves, bounded to the reviewer's ticket. */
  readonly resources: ResourceHost
}

/** Returns the reviewer Session's tools: `orchestrator_read` for the ticket it reviews. */
export function reviewerTools(host: ReviewerToolsHost, ticket: Ticket): Tool[] {
  return [readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
    true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticket.id, signal))]
}
