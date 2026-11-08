/** Dispatcher view: which Session judges and assigns work, and whether it is reachable and busy. */
import { usePoll, type DispatcherView } from './api.ts'
import { LoadState, Section, Hint } from './widgets.tsx'
import { usePanel } from './provider.tsx'

export function DispatcherPage() {
  const { t } = usePanel()
  const { data, error } = usePoll(() => call('GET dispatcher'), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    <Section title={t('tab.dispatcher')}>
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherId')}</span>
          <span className="dt-stat-value">{data.id}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherReachable')}</span>
          <span className="dt-stat-value">{data.available ? '✓' : '—'}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('dispatcherRunning')}</span>
          <span className="dt-stat-value">{data.running ? t('dispatcherRunning') : t('dispatcherIdle')}</span></span>
      </div>
    </Section>
    {!data.available && <Hint>{t('dispatcherNone')}</Hint>}
  </>
}

declare function call(path: 'GET dispatcher'): Promise<DispatcherView>