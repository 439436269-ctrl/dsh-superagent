/** Dispatcher view: which Session judges and assigns work, how it was chosen, and how to change or reset it. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'
import { usePanel } from './provider.tsx'

export function DispatcherPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET dispatcher'), [])
  const list = usePoll(() => call('GET dispatcher/sessions'), [])
  const [busy, setBusy] = useState(false)
  const [id, setId] = useState('')
  if (!data) return <LoadState error={error} loading />
  // The default dispatcher is the one this plugin created: its id is derived, and always starts the same way.
  const claimed = !data.id.startsWith('orchestrator-')
  const set = async (next: string | null) => { setBusy(true); try { await call('POST dispatcher', { body: { id: next } }); await reload() } finally { setBusy(false) } }
  const sessions = (list.data ?? []).filter(item => item.id !== data.id)
  return <>
    <Section title={t('tab.dispatcher')}>
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherKind')}</span>
          <span className="dt-stat-value">{claimed ? t('dispatcherClaimed') : t('dispatcherDefault')}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherId')}</span>
          <span className="dt-stat-value">{data.id}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherReachable')}</span>
          <span className="dt-stat-value">{data.available ? '✓' : '—'}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherRunning')}</span>
          <span className="dt-stat-value">{data.running ? t('dispatcherRunning') : t('dispatcherIdle')}</span></span>
      </div>
      {!data.available && <Hint>{t('dispatcherNone')}</Hint>}
      {data.note && <Hint>{data.note}</Hint>}
    </Section>
    <Section title={t('dispatcherChange')}>
      {/* Sessions the Host can see, if any; a typed id is the fallback when nothing is listed. */}
      {sessions.length === 0 ? <Hint>{t('dispatcherNoSessions')}</Hint>
        : <ul className="dt-list">{sessions.map(item => <li key={item.id}>
          <span>{item.cwd || item.id}{item.running ? ` · ${t('dispatcherRunning')}` : ''}</span>
          <Button disabled={busy} onClick={() => set(item.id)}>{t('dispatcherUse')}</Button>
        </li>)}</ul>}
      <Input value={id} placeholder={t('dispatcherPlaceholder')} onChange={event => setId(event.target.value)} />
      <Button disabled={busy || !id.trim()} onClick={() => set(id.trim())}>{t('dispatcherUse')}</Button>
      <Button disabled={busy || !claimed} onClick={() => set(null)}>{t('dispatcherReset')}</Button>
    </Section>
  </>
}