import { useId, type ReactNode } from 'react'
import './media-connections.css'

export function ConnectionGroup({ name, count, children }: { name: string; count: number; children: ReactNode }) {
  const title = useId()
  return <section className="connection-group" aria-labelledby={title}>
    <div className="connection-group-heading"><h4 id={title}>{name}</h4><span>{count} 个服务</span></div>
    <ul className="service-list">{children}</ul>
  </section>
}

interface CardProps {
  name: string
  description: string
  base: string
  actions: ReactNode
  modelLabel?: string
  children: ReactNode
}
export function ConnectionCard({ name, description, base, actions, modelLabel, children }: CardProps) {
  const title = useId()
  return <article className="saved-connection" aria-labelledby={title}>
    <header className="saved-connection-heading">
      <div className="saved-connection-info">
        <h5 id={title}>{name}</h5>
        {description && <p>{description}</p>}
        <code>{base}</code>
      </div>
      <div className="connection-actions">{actions}</div>
    </header>
    {modelLabel ? !!children && <div className="connection-models">
      <span>{modelLabel}</span>
      <ul aria-label={modelLabel}>{children}</ul>
    </div> : children}
  </article>
}
