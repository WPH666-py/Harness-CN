import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnBlockedNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn whose proposed step a pre-step listener rejected. */
    'turn-blocked': TurnBlockedNode
  }
}

interface TurnBlockedState {
  readonly turn: number
  readonly seq: number
  readonly time: number
}

function lastStep(context: ConversationNodeContext<TurnBlockedState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

function stateFrom(match: ConversationMatch): TurnBlockedState | undefined {
  if (match.event.type !== 'turn/end' || match.event.data.reason.kind !== 'blocked') return undefined
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time }
}

/**
 * Notice Definition for a turn a pre-step listener blocked. The rejected input
 * never reached the model, so without this row a blocked turn shows no reason
 * for producing no answer.
 */
export const turnBlockedDefinition: ConversationNodeDefinition<TurnBlockedState> = {
  kind: 'turn-blocked',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'blocked') {
      return { id: String(event.data.turn), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('turn-blocked start requires a blocked turn/end')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const node: TurnBlockedNode = {
      kind: 'turn-blocked',
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: lastStep(context),
    }
    // Just before the turn-tail so the notice owns the visible end of a turn
    // that produced no Assistant content.
    return chatNode(context, 'turn-blocked', state.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.blockedNotice, node)
  },
}

/**
 * Register the blocked-turn notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnBlockedConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnBlockedDefinition)
}
