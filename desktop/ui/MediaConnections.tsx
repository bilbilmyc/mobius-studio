import { groupProfiles, mediaKind, presets, profileModels, type ProfileView } from '../shared'
import { ConnectionCard, ConnectionGroup } from './ConnectionCards'

export interface MediaConnectionProps {
  profiles: ProfileView[]
  official?: ProfileView
  edit: (official: boolean, profile?: ProfileView) => void
  remove: (profile: ProfileView) => void
}

export function MediaConnections({ official, profiles, edit, remove }: MediaConnectionProps) {
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
      {groupProfiles(profiles).map(group => <ConnectionGroup key={group.id} name={group.name} count={group.profiles.length}>
          {group.profiles.map(p => <li key={p.Id}>
            <SavedConnection profile={p} edit={edit} remove={remove} />
          </li>)}
      </ConnectionGroup>)}
    </section>
  </>
}

function SavedConnection({ profile, edit, remove }: Pick<MediaConnectionProps, 'edit' | 'remove'> & { profile: ProfileView }) {
  const models = profileModels(profile).filter(Boolean)
  const modelLabel = mediaKind(profile.ProtocolId) === 'image' ? '图片模型' : '视频模型'
  return <ConnectionCard name={profile.Name} description={presets[profile.ProtocolId]?.title} base={profile.BaseUrl}
    modelLabel={modelLabel} actions={<>
      <button aria-label={`编辑 ${profile.Name}`} onClick={() => edit(false, profile)}>编辑</button>
      <button aria-label={`移除 ${profile.Name}`} onClick={() => remove(profile)}>移除</button>
    </>}>
    {models.length > 0 && models.map(model => <li key={model}>
      <code>{model}</code>{models.length > 1 && model === profile.Model && <small>默认</small>}
    </li>)}
  </ConnectionCard>
}
