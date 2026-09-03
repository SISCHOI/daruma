/**
 * FailoverNoticeRow — the daruma chat renderer for {@link FAILOVER_NOTICE_KIND}.
 *
 * A single quiet row inside the conversation flow telling the user that
 * daruma caught a failed model request and switched the channel for the
 * retry. Registered behind the host's keyed `conversation.chat.node` seat,
 * so it renders exactly like an in-repo chat row (no DOM injection).
 */

import { createElement as h, type CSSProperties } from 'react'
import {
  failoverNoticeCopy,
  parseFailoverNotice,
  type FailoverNoticeData,
} from './failover-notice.ts'

/** Renderer props actually consumed (the keyed seat passes more; ignore it). */
export interface FailoverNoticeRowProps {
  readonly node: { readonly data: FailoverNoticeData }
  readonly t: (key: string) => string
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  padding: '2px 4px',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const dotStyle: CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  flex: 'none',
  background: 'var(--dsw-static-deepseek-500)',
}

const brandStyle: CSSProperties = {
  flex: 'none',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const lineStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
}

/** Render one settled failover row, or nothing when the payload is unusable. */
export function FailoverNoticeRow({ node, t }: FailoverNoticeRowProps) {
  const data = parseFailoverNotice(node.data as unknown)
  if (data === null) return null
  const { line, detail } = failoverNoticeCopy(data, t)
  const title = line === detail ? detail : `${line} · ${detail}`
  return h(
    'div',
    {
      'data-daruma-notice': 'true',
      role: 'note',
      style: rowStyle,
      title,
    },
    [
      h('span', { 'aria-hidden': true, style: dotStyle }),
      h('span', { style: brandStyle }, 'daruma'),
      h('span', { style: lineStyle }, line),
    ],
  )
}
