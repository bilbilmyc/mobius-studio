import { groupProfiles, isSite, mediaKind, presets, profileModels, serviceRoutes, type MediaKind, type ProfileView } from '../shared'
import { ConnectionCard, ConnectionGroup } from './ConnectionCards'

export interface MediaConnectionProps {
  profiles: ProfileView[]
  official?: ProfileView
  edit: (official: boolean, profile?: ProfileView) => void
  addModel: (routes: ProfileView[], kind: MediaKind) => void
  remove: (profile: ProfileView) => void
}

export function MediaConnections({ official, profiles, edit, remove, addModel }: MediaConnectionProps) {
  const services = serviceRoutes(profiles)
  const representatives = Array.from(services.values(), routes => routes[0])
  return <>
    <section className="featured-connection" aria-labelledby="official-connection-title">
      <div>
        <h3 id="official-connection-title">内置官网</h3>
        <div className="connection-identity">
          <h4>AIGC 创作空间</h4>
          <span className="connection-key-state" data-configured={!!official?.hasKey}>
            {official?.hasKey ? 'Key 已配置' : 'Key 待配置'}
          </span>
        </div>
        <p>官网图片与视频共用一个 Key。</p>
      </div>
      <button onClick={() => edit(true, official)}>配置官网 Key</button>
    </section>

    <section className="external-connections" aria-labelledby="external-connections-title">
      <header className="connections-heading">
        <h3 id="external-connections-title">我的模型服务</h3>
        <button className="add-connection" onClick={() => edit(false)}><span aria-hidden="true">＋</span>添加模型服务</button>
      </header>
      {profiles.length === 0 && <p className="connections-empty">还没有添加服务。可接入中转站、模型厂商或本地 ComfyUI。</p>}
      {groupProfiles(representatives).map(group => <ConnectionGroup key={group.id} name={group.name} count={group.profiles.length}>
          {group.profiles.map(p => <li key={p.Id}>
            <SavedConnection routes={services.get(p.ServiceId ?? p.Id)!} edit={edit} remove={remove} addModel={addModel} />
          </li>)}
      </ConnectionGroup>)}
    </section>
  </>
}

function SavedConnection({ routes, edit, remove, addModel }: Pick<MediaConnectionProps, 'edit' | 'remove' | 'addModel'> & { routes: ProfileView[] }) {
  const service = routes[0]
  const single = routes.length === 1
  const routeActions = (p: ProfileView) => {
    const label = single ? p.Name : presets[p.ProtocolId].title
    return <>
      <button aria-label={`编辑 ${label}`} onClick={() => edit(false, p)}>编辑</button>
      <button aria-label={`移除 ${label}`} onClick={() => remove(p)}>移除</button>
    </>
  }
  return <ConnectionCard name={service.Name} description={single ? presets[service.ProtocolId]?.title : ''} base={service.BaseUrl}
    actions={<>
      {!isSite(service.ProtocolId) && service.ProtocolId !== 'comfy-image' && <>
        <button onClick={() => addModel(routes, 'image')}>添加图片模型</button>
        <button onClick={() => addModel(routes, 'video')}>添加视频模型</button>
      </>}
      {single && routeActions(service)}
    </>}>
    {routes.map(p => {
      const label = mediaKind(p.ProtocolId) === 'image' ? '图片模型' : '视频模型'
      const models = profileModels(p).filter(Boolean)
      return <div key={p.Id} className="connection-models">
        <div className="saved-connection-heading">
          <span>{label}{!single && ' · ' + presets[p.ProtocolId].title}</span>
          {!single && <div className="connection-actions">{routeActions(p)}</div>}
        </div>
        <ul aria-label={label}>{models.map(model => <li key={model}>
          <code>{model}</code>{models.length > 1 && model === p.Model && <small>默认</small>}
        </li>)}</ul>
      </div>
    })}
  </ConnectionCard>
}
