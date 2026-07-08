import { useState, useEffect, useMemo } from 'react';
import type { PublicSkillInfo, SkillInfo } from '../simulator/types';
import { initSkills, saveSkills } from '../simulator/mock-data';
import { loadCachedAgentTemplates } from '../utils/agent-templates';
import { useAuth } from '../contexts/AuthContext';
import { getAuthHeaders } from '../utils/client-runtime';
import { parseConversationIdInput } from '../utils/conversation-links';
import StatusBadge from '../components/common/StatusBadge';

const LOCATION_LABELS: Record<string, { label: string; color: string }> = {
  user: { label: '用户级', color: 'var(--info)' },
  project: { label: '项目级', color: 'var(--success)' },
  plugin: { label: '插件', color: 'var(--warning)' },
};

function candidatePath(skill: SkillInfo) {
  return skill.sourcePath || skill.path;
}

function toPublicSkillInfo(data: Record<string, unknown>): PublicSkillInfo {
  return {
    id: String(data.id || ''),
    slug: String(data.slug || ''),
    name: String(data.name || ''),
    description: String(data.description || ''),
    authorSub: String(data.authorSub || ''),
    authorTenantId: String(data.authorTenantId || ''),
    revision: Number(data.revision || 0),
    publishedAt: Number(data.publishedAt || 0),
    updatedAt: Number(data.updatedAt || 0),
  };
}

function shortDate(timestamp: number) {
  return timestamp ? new Date(timestamp).toLocaleDateString() : '未知';
}

function mergeSkillsWithLocalState(serverSkills: SkillInfo[], localSkills: SkillInfo[]) {
  const localByName = new Map(localSkills.map(skill => [skill.name, skill]));
  const merged = serverSkills.map(skill => {
    const local = localByName.get(skill.name);
    return local ? { ...skill, enabled: local.enabled } : skill;
  });
  const serverNames = new Set(merged.map(skill => skill.name));
  const extraLocal = localSkills.filter(skill => skill.location !== 'user' && !serverNames.has(skill.name));
  return [...merged, ...extraLocal];
}

export default function Skills() {
  const { user } = useAuth();
  const [activeView, setActiveView] = useState<'backpack' | 'public'>('backpack');
  const [skills, setSkills] = useState<SkillInfo[]>(() => initSkills());
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    saveSkills(skills);
  }, [skills]);

  const toggleSkill = (name: string) => {
    setSkills(prev => prev.map(s => s.name === name ? { ...s, enabled: !s.enabled } : s));
  };

  // 每个技能被多少个 Agent 模板引用(模板自身 skills + 其 subagents 的 skills,每个模板至多计一次)
  const skillUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const template of loadCachedAgentTemplates(user?.tenantId)) {
      const names = new Set<string>();
      if (Array.isArray(template.skills)) template.skills.forEach(n => names.add(n));
      if (template.subagents) {
        for (const sub of Object.values(template.subagents)) {
          if (Array.isArray(sub.skills)) sub.skills.forEach(n => names.add(n));
        }
      }
      names.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));
    }
    return counts;
  }, [user?.tenantId]);

  const deleteSkill = async (skill: SkillInfo) => {
    const uses = skillUsage.get(skill.name) || 0;
    const onDisk = skill.location === 'user';
    const lines = [
      onDisk
        ? `彻底删除技能 "${skill.name}"？将移除磁盘上的 ~/.claude/skills/${skill.name}/，不可恢复。`
        : `从技能背包移除 "${skill.name}"？（该技能不在用户目录，仅从列表移除，不删除任何文件）`,
    ];
    if (uses > 0) lines.push(`⚠ 当前有 ${uses} 个 Agent 引用该技能，删除后它们将失去此能力。`);
    if (!window.confirm(lines.join('\n\n'))) return;

    if (onDisk) {
      try {
        const res = await fetch(`/api/skills/user/${encodeURIComponent(skill.name)}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        // 404 视为已删除:磁盘已无该目录,继续从列表移除
        if (!res.ok && res.status !== 404) {
          setActionMsg({ type: 'error', text: data.error || `删除失败: HTTP ${res.status}` });
          return;
        }
      } catch (e) {
        setActionMsg({ type: 'error', text: `删除失败: ${(e as Error).message}` });
        return;
      }
    }
    setSkills(prev => prev.filter(s => s.name !== skill.name));
    setActionMsg({ type: 'success', text: `已删除技能 "${skill.name}"${onDisk ? '（含磁盘文件）' : ''}。` });
  };

  // GitHub 导入
  const [ghUrl, setGhUrl] = useState('');
  const [ghLoading, setGhLoading] = useState(false);
  const [ghMsg, setGhMsg] = useState('');

  const [localLoading, setLocalLoading] = useState(false);
  const [localMsg, setLocalMsg] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [localCandidates, setLocalCandidates] = useState<SkillInfo[]>([]);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([]);

  // 新增的 workspace 抽取并安装能力
  const [workspaceConversationId, setWorkspaceConversationId] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceMsg, setWorkspaceMsg] = useState('');
  const [workspaceCandidates, setWorkspaceCandidates] = useState<SkillInfo[]>([]);
  const [selectedWorkspacePaths, setSelectedWorkspacePaths] = useState<string[]>([]);
  const [publicSkills, setPublicSkills] = useState<PublicSkillInfo[]>([]);
  const [publicLoading, setPublicLoading] = useState(false);
  const [learningId, setLearningId] = useState('');
  const [publishingName, setPublishingName] = useState('');
  const [learnConflict, setLearnConflict] = useState<{ skill: PublicSkillInfo; message: string } | null>(null);
  const [learnNameOverride, setLearnNameOverride] = useState('');
  const workspaceConversationLabel = parseConversationIdInput(workspaceConversationId) || workspaceConversationId.trim();

  const handleImportFromGitHub = async () => {
    if (!ghUrl.trim()) return;
    setGhLoading(true);
    setGhMsg('');

    try {
      let rawUrl = ghUrl.trim();
      if (rawUrl.includes('github.com') && !rawUrl.includes('raw.githubusercontent.com')) {
        rawUrl = rawUrl
          .replace('https://github.com/', 'https://raw.githubusercontent.com/')
          .replace('/blob/', '/');
      }
      if (!rawUrl.endsWith('SKILL.md') && !rawUrl.endsWith('.md')) {
        rawUrl = rawUrl.replace(/\/$/, '') + '/SKILL.md';
      }

      const res = await fetch(rawUrl);
      if (!res.ok) {
        setGhMsg(`获取失败: HTTP ${res.status}, 请检查 URL 是否正确`);
        return;
      }

      const content = await res.text();
      const parts = rawUrl.replace('/SKILL.md', '').split('/');
      const skillName = parts[parts.length - 1] || 'imported-skill';

      if (skills.find(s => s.name === skillName)) {
        setGhMsg(`技能 "${skillName}" 已存在，跳过导入`);
        return;
      }

      const titleMatch = content.match(/^#\s+(.+)/m);
      const description = titleMatch ? titleMatch[1] : `从 GitHub 导入: ${rawUrl}`;

      const newSkill: SkillInfo = {
        name: skillName,
        description,
        location: 'plugin',
        path: rawUrl.replace('/SKILL.md', '/'),
        enabled: true,
      };

      setSkills(prev => [...prev, newSkill]);
      setGhUrl('');
      setGhMsg(`✓ 已导入 "${skillName}"`);
    } catch (e) {
      setGhMsg(`导入失败: ${(e as Error).message}`);
    } finally {
      setGhLoading(false);
    }
  };

  const toSkillInfo = (data: Record<string, unknown>, fallbackPath: string): SkillInfo => {
    const location = data.location === 'project' || data.location === 'plugin' ? data.location : 'user';
    return {
      name: String(data.name || '').trim() || 'local-skill',
      description: String(data.description || '').trim() || `本地技能: ${fallbackPath}`,
      location,
      path: String(data.path || fallbackPath),
      enabled: data.enabled === false ? false : true,
      sourcePath: typeof data.sourcePath === 'string' ? data.sourcePath : undefined,
      installedPath: typeof data.installedPath === 'string' ? data.installedPath : undefined,
      installed: data.installed === true,
      learnedFromPublicSkillId: typeof data.learnedFromPublicSkillId === 'string' ? data.learnedFromPublicSkillId : undefined,
      learnedFromPublicRevision: typeof data.learnedFromPublicRevision === 'number' ? data.learnedFromPublicRevision : undefined,
      learnedAt: typeof data.learnedAt === 'number' ? data.learnedAt : undefined,
    };
  };

  const parseSkillList = (value: unknown, fallbackPath: string) => (
    Array.isArray(value)
      ? value.map(item => toSkillInfo((item || {}) as Record<string, unknown>, fallbackPath))
      : []
  );

  const loadInstalledSkills = async () => {
    const seed = initSkills();
    try {
      const res = await fetch('/api/skills', { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionMsg({ type: 'error', text: data.error || `读取技能背包失败: HTTP ${res.status}` });
        return;
      }
      const serverSkills = parseSkillList(data.skills, '~/.claude/skills');
      setSkills(mergeSkillsWithLocalState(serverSkills, seed));
    } catch (e) {
      setActionMsg({ type: 'error', text: `读取技能背包失败: ${(e as Error).message}` });
    }
  };

  const loadPublicSkills = async () => {
    setPublicLoading(true);
    try {
      const res = await fetch('/api/skills/public', { headers: getAuthHeaders() });
      const data = await res.json().catch(() => []);
      if (!res.ok) {
        setActionMsg({ type: 'error', text: data.error || `读取公共技能失败: HTTP ${res.status}` });
        return;
      }
      setPublicSkills(
        Array.isArray(data)
          ? data.map((item: Record<string, unknown>) => toPublicSkillInfo(item)).filter((skill: PublicSkillInfo) => skill.id)
          : [],
      );
    } catch (e) {
      setActionMsg({ type: 'error', text: `读取公共技能失败: ${(e as Error).message}` });
    } finally {
      setPublicLoading(false);
    }
  };

  useEffect(() => {
    if (!user?.tenantId) return;
    void loadInstalledSkills();
    void loadPublicSkills();
  }, [user?.tenantId]);

  const scanLocalPath = async (pathToScan: string) => {
    const inputPath = pathToScan.trim();
    if (!inputPath) return;
    setLocalLoading(true);
    setLocalMsg('');
    setLocalCandidates([]);
    setSelectedLocalPaths([]);

    try {
      const res = await fetch('/api/skills/scan-local', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path: inputPath }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLocalMsg(`扫描失败: ${data.error || `HTTP ${res.status}`}`);
        return;
      }

      const candidates = parseSkillList(data.skills, inputPath);
      if (!candidates.length) {
        setLocalMsg('没有找到可导入的技能');
        return;
      }

      const existingNames = new Set(skills.map(s => s.name));
      const defaultSelected = candidates
        .filter(skill => !existingNames.has(skill.name))
        .map(skill => skill.path);
      setLocalCandidates(candidates);
      setSelectedLocalPaths(defaultSelected);
      setLocalMsg(`✓ 找到 ${candidates.length} 个技能，已选择 ${defaultSelected.length} 个可导入项`);
    } catch (e) {
      setLocalMsg(`扫描失败: ${(e as Error).message}`);
    } finally {
      setLocalLoading(false);
    }
  };

  const handlePickLocalPath = async (kind: 'directory' | 'file') => {
    setLocalLoading(true);
    setLocalMsg('');
    try {
      const res = await fetch('/api/skills/pick-local-path', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLocalMsg(`选择失败: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      const pickedPath = String(data.path || '').trim();
      if (!pickedPath) {
        setLocalMsg('已取消选择路径');
        return;
      }
      setLocalPath(pickedPath);
      await scanLocalPath(pickedPath);
    } catch (e) {
      setLocalMsg(`选择失败: ${(e as Error).message}`);
    } finally {
      setLocalLoading(false);
    }
  };

  const handleScanLocalPath = () => {
    void scanLocalPath(localPath);
  };

  const toggleLocalCandidate = (skillPath: string) => {
    setSelectedLocalPaths(prev => (
      prev.includes(skillPath) ? prev.filter(path => path !== skillPath) : [...prev, skillPath]
    ));
  };

  const selectAllLocalCandidates = () => {
    const existingNames = new Set(skills.map(s => s.name));
    setSelectedLocalPaths(localCandidates.filter(skill => !existingNames.has(skill.name)).map(skill => skill.path));
  };

  const importSelectedLocalSkills = () => {
    const selected = localCandidates.filter(skill => selectedLocalPaths.includes(skill.path));
    if (!selected.length) {
      setLocalMsg('请先选择要导入的技能');
      return;
    }

    const existingNames = new Set(skills.map(s => s.name));
    const toAdd = selected.filter(skill => !existingNames.has(skill.name));
    const skipped = selected.length - toAdd.length;
    if (toAdd.length > 0) setSkills(prev => [...prev, ...toAdd]);
    setLocalPath('');
    setLocalCandidates([]);
    setSelectedLocalPaths([]);
    setLocalMsg(`✓ 已导入 ${toAdd.length} 个技能${skipped ? `，跳过 ${skipped} 个已存在` : ''}`);
  };

  const handleScanWorkspacePath = async () => {
    const conversationId = parseConversationIdInput(workspaceConversationId);
    if (!conversationId) {
      setWorkspaceMsg('请粘贴包含 conversationId 或 join 参数的会话链接，或直接输入对话 ID');
      return;
    }
    if (conversationId !== workspaceConversationId.trim()) setWorkspaceConversationId(conversationId);
    setWorkspaceLoading(true);
    setWorkspaceMsg('');
    setWorkspaceCandidates([]);
    setSelectedWorkspacePaths([]);

    try {
      const res = await fetch('/api/skills/workspace/scan', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setWorkspaceMsg(`扫描失败: ${data.error || `HTTP ${res.status}`}`);
        return;
      }

      const candidates = parseSkillList(data.skills, conversationId);
      if (!candidates.length) {
        setWorkspaceMsg('没有找到可安装的 workspace 技能');
        return;
      }

      const defaultSelected = candidates
        .map(candidatePath);
      setWorkspaceCandidates(candidates);
      setSelectedWorkspacePaths(defaultSelected);
      setWorkspaceMsg(`✓ 从对话 ${conversationId} 找到 ${candidates.length} 个 workspace 技能，已选择 ${defaultSelected.length} 个可安装项`);
    } catch (e) {
      setWorkspaceMsg(`扫描失败: ${(e as Error).message}`);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const toggleWorkspaceCandidate = (skillPath: string) => {
    setSelectedWorkspacePaths(prev => (
      prev.includes(skillPath) ? prev.filter(path => path !== skillPath) : [...prev, skillPath]
    ));
  };

  const selectAllWorkspaceCandidates = () => {
    setSelectedWorkspacePaths(
      workspaceCandidates
        .map(candidatePath),
    );
  };

  const installSelectedWorkspaceSkills = async () => {
    const conversationId = parseConversationIdInput(workspaceConversationId);
    if (!conversationId) {
      setWorkspaceMsg('请粘贴包含 conversationId 或 join 参数的会话链接，或直接输入对话 ID');
      return;
    }
    if (conversationId !== workspaceConversationId.trim()) setWorkspaceConversationId(conversationId);
    const selected = workspaceCandidates.filter(skill => selectedWorkspacePaths.includes(candidatePath(skill)));
    if (!selected.length) {
      setWorkspaceMsg('请先选择要安装的 workspace 技能');
      return;
    }
    const existingNames = new Set(skills.map(skill => skill.name));
    const shouldOverwrite = (skill: SkillInfo) => existingNames.has(skill.name) || skill.installed === true;
    const overwriteNames = selected.filter(shouldOverwrite).map(skill => skill.name);
    if (overwriteNames.length) {
      const confirmed = window.confirm(
        `将覆盖我的技能背包中的同名技能：${overwriteNames.join('、')}。\n\n覆盖后原技能不可恢复，确定继续导入吗？`,
      );
      if (!confirmed) return;
    }

    setWorkspaceLoading(true);
    setWorkspaceMsg('');
    const installed: SkillInfo[] = [];
    const failed: string[] = [];

    for (const skill of selected) {
      const sourcePath = candidatePath(skill);
      try {
        const res = await fetch('/api/skills/workspace/install', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ conversationId, name: skill.name, overwrite: shouldOverwrite(skill) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          failed.push(`${skill.name}: ${data.error || `HTTP ${res.status}`}`);
          continue;
        }
        installed.push(toSkillInfo(data as Record<string, unknown>, sourcePath));
      } catch (e) {
        failed.push(`${skill.name}: ${(e as Error).message}`);
      }
    }

    if (installed.length) {
      setSkills(prev => {
        const installedNames = new Set(installed.map(skill => skill.name));
        return [
          ...prev.filter(skill => !installedNames.has(skill.name)),
          ...installed,
        ];
      });
    }
    setWorkspaceCandidates(prev => prev.map(skill => (
      installed.some(item => item.name === skill.name)
        ? { ...skill, installed: true, installedPath: installed.find(item => item.name === skill.name)?.path }
        : skill
    )));
    setSelectedWorkspacePaths([]);
    const overwroteCount = installed.filter(skill => overwriteNames.includes(skill.name)).length;
    setWorkspaceMsg([
      installed.length ? `✓ 已安装 ${installed.length} 个技能到你的技能背包` : '',
      overwroteCount ? `覆盖 ${overwroteCount} 个同名技能` : '',
      failed.length ? `失败 ${failed.length} 个：${failed.join('；')}` : '',
    ].filter(Boolean).join(' '));
    setWorkspaceLoading(false);
  };

  const learnPublicSkill = async (skill: PublicSkillInfo, nameOverride?: string) => {
    setLearningId(skill.id);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/skills/public/${encodeURIComponent(skill.id)}/learn`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(nameOverride ? { nameOverride } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setLearnConflict({ skill, message: data.error || '背包中已存在同名技能' });
          setLearnNameOverride(`${skill.slug || skill.name}-copy`);
        } else {
          setActionMsg({ type: 'error', text: data.error || `学习失败: HTTP ${res.status}` });
        }
        return;
      }
      const installedSkill = toSkillInfo(data as Record<string, unknown>, skill.name);
      setSkills(prev => {
        const existing = new Set(prev.map(item => item.name));
        return existing.has(installedSkill.name) ? prev : [...prev, installedSkill];
      });
      setLearnConflict(null);
      setLearnNameOverride('');
      setActiveView('backpack');
      setActionMsg({ type: 'success', text: `已学习 "${installedSkill.name}"，现在可以在我的技能背包里启用。` });
    } catch (e) {
      setActionMsg({ type: 'error', text: `学习失败: ${(e as Error).message}` });
    } finally {
      setLearningId('');
    }
  };

  const publishSkill = async (skill: SkillInfo) => {
    if (!window.confirm(`发布 "${skill.name}" 到公共空间？公共空间会影响之后学习这个技能的人。`)) return;
    setPublishingName(skill.name);
    setActionMsg(null);
    try {
      const res = await fetch('/api/skills/public', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          path: skill.installedPath || skill.path,
          name: skill.name,
          description: skill.description,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionMsg({ type: 'error', text: data.error || `发布失败: HTTP ${res.status}` });
        return;
      }
      await loadPublicSkills();
      setActiveView('public');
      setActionMsg({ type: 'success', text: `已发布公共技能 "${data.name || skill.name}"。` });
    } catch (e) {
      setActionMsg({ type: 'error', text: `发布失败: ${(e as Error).message}` });
    } finally {
      setPublishingName('');
    }
  };

  const enabledCount = skills.filter(s => s.enabled).length;
  const learnedCount = skills.filter(s => s.learnedFromPublicSkillId).length;
  const canPublish = user?.role === 'tenant_admin';

  return (
    <div>
      <div className="page-header">
        <h1>🎒 技能背包</h1>
        <p>管理 Agent Skills — 扩展 Agent 的专业能力，模型按需自动调用</p>
      </div>

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        <button
          className={`btn ${activeView === 'backpack' ? 'btn-primary' : ''}`}
          onClick={() => setActiveView('backpack')}
        >
          我的技能背包
        </button>
        <button
          className={`btn ${activeView === 'public' ? 'btn-primary' : ''}`}
          onClick={() => setActiveView('public')}
        >
          公共技能
        </button>
      </div>

      {actionMsg && (
        <div
          className="card mb-4"
          style={{
            borderColor: actionMsg.type === 'success' ? 'var(--success)' : 'var(--danger)',
            color: actionMsg.type === 'success' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {actionMsg.text}
        </div>
      )}

      {activeView === 'public' ? (
        <>
          <div className="grid-3 mb-4">
            <div className="kpi-card">
              <div className="kpi-label">公共技能</div>
              <div className="kpi-value">{publicSkills.length}</div>
              <div className="kpi-sub">可学习模板</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">已学习</div>
              <div className="kpi-value" style={{ color: 'var(--success)' }}>{learnedCount}</div>
              <div className="kpi-sub">我的背包副本</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">公共规则</div>
              <div className="kpi-value" style={{ fontSize: '.82em', fontFamily: 'var(--font-mono)' }}>copy</div>
              <div className="kpi-sub">学习后独立编辑</div>
            </div>
          </div>

          {learnConflict && (
            <div className="card mb-4" style={{ borderColor: 'var(--warning)' }}>
              <div className="card-header">技能名冲突</div>
              <div style={{ fontSize: '.84em', color: 'var(--ink-secondary)', marginBottom: 10 }}>
                {learnConflict.message}
              </div>
              <div className="flex gap-2" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <input
                  value={learnNameOverride}
                  onChange={event => setLearnNameOverride(event.target.value)}
                  placeholder="新的技能名"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em', flex: '1 1 240px' }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => { void learnPublicSkill(learnConflict.skill, learnNameOverride); }}
                  disabled={!learnNameOverride.trim() || learningId === learnConflict.skill.id}
                >
                  {learningId === learnConflict.skill.id ? '学习中...' : '改名学习'}
                </button>
                <button className="btn" onClick={() => setLearnConflict(null)}>取消</button>
              </div>
            </div>
          )}

          <div className="flex-between mb-3" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div className="section-title" style={{ marginBottom: 0 }}>公共技能</div>
            <button className="btn btn-sm" onClick={() => { void loadPublicSkills(); }} disabled={publicLoading}>
              {publicLoading ? '刷新中...' : '刷新'}
            </button>
          </div>

          {publicLoading ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>
              加载中...
            </div>
          ) : publicSkills.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>
              暂无公共技能
            </div>
          ) : (
            <div className="grid-2">
              {publicSkills.map(skill => {
                const alreadyLearned = skills.some(item => item.learnedFromPublicSkillId === skill.id);
                return (
                  <div key={skill.id} className="tool-card">
                    <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="tool-card-name">{skill.name}</div>
                        <div className="tool-card-desc">{skill.description}</div>
                        <div className="mt-2 flex gap-2" style={{ flexWrap: 'wrap' }}>
                          <span className="badge badge-muted">{skill.slug}</span>
                          <span className="badge badge-info">rev {skill.revision}</span>
                          <span className="badge badge-muted">{shortDate(skill.updatedAt)}</span>
                        </div>
                        <div className="mt-1" style={{ fontSize: '.72em', color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
                          {skill.authorSub}
                        </div>
                      </div>
                      <div className="flex gap-2" style={{ flexDirection: 'column', alignItems: 'stretch', flex: '0 0 auto' }}>
                        {alreadyLearned && <span className="badge badge-success">已学习</span>}
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => { void learnPublicSkill(skill); }}
                          disabled={learningId === skill.id}
                        >
                          {learningId === skill.id ? '学习中...' : '学习技能'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
      <div className="card mb-4">
        <div className="card-header">从 GitHub 导入技能</div>
        <div style={{ fontSize: '.82em', color: 'var(--ink-secondary)', marginBottom: 10 }}>
          输入 GitHub 仓库地址或 SKILL.md 原始链接，自动同步技能定义
        </div>
        <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
          <input
            value={ghUrl}
            onChange={e => setGhUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleImportFromGitHub(); }}
            placeholder="https://github.com/user/skill-repo 或 raw URL"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em', flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleImportFromGitHub} disabled={ghLoading}>
            {ghLoading ? '导入中...' : '导入'}
          </button>
        </div>
        {ghMsg && (
          <div className="mt-2" style={{
            fontSize: '.8em',
            color: ghMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)',
          }}>
            {ghMsg}
          </div>
        )}
      </div>

      <div className="card mb-4">
        <div className="card-header">从本机导入技能</div>
        <div style={{ fontSize: '.82em', color: 'var(--ink-secondary)', marginBottom: 10 }}>
          选择技能目录，或输入路径扫描。
        </div>
        <div className="flex gap-2 mb-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => { void handlePickLocalPath('directory'); }} disabled={localLoading}>
            {localLoading ? '处理中...' : '选择目录'}
          </button>
          <button className="btn" onClick={() => { void handlePickLocalPath('file'); }} disabled={localLoading}>
            选择 SKILL.md
          </button>
        </div>
        <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
          <input
            value={localPath}
            onChange={e => setLocalPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleScanLocalPath(); }}
            placeholder="/Users/xiaoqin/.codex/skills 或 /path/to/SKILL.md"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em', flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleScanLocalPath} disabled={localLoading}>
            {localLoading ? '扫描中...' : '扫描路径'}
          </button>
        </div>
        {localCandidates.length > 0 && (
          <div className="mt-3" style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div className="flex-between" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.82em', fontWeight: 600 }}>
                候选技能 {selectedLocalPaths.length}/{localCandidates.length}
              </span>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={selectAllLocalCandidates}>全选</button>
                <button className="btn btn-sm" onClick={() => setSelectedLocalPaths([])}>清空</button>
                <button className="btn btn-primary btn-sm" onClick={importSelectedLocalSkills}>
                  导入选中
                </button>
              </div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {localCandidates.map(skill => {
                const exists = skills.some(s => s.name === skill.name);
                return (
                  <label
                    key={skill.path}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 10,
                      alignItems: 'start',
                      padding: '9px 10px',
                      borderBottom: '1px solid var(--border)',
                      cursor: exists ? 'not-allowed' : 'pointer',
                      opacity: exists ? .58 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      disabled={exists}
                      checked={selectedLocalPaths.includes(skill.path)}
                      onChange={() => toggleLocalCandidate(skill.path)}
                      style={{ width: 'auto', marginTop: 3 }}
                    />
                    <span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.82em', fontWeight: 600 }}>
                        {skill.name}
                      </span>
                      <span style={{ display: 'block', fontSize: '.75em', color: 'var(--ink-secondary)', marginTop: 2 }}>
                        {skill.description}
                      </span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.68em', color: 'var(--ink-muted)', marginTop: 2 }}>
                        {skill.path}
                      </span>
                    </span>
                    {exists && <span className="badge badge-muted">已存在</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
        {localMsg && (
          <div className="mt-2" style={{
            fontSize: '.8em',
            color: localMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)',
          }}>
            {localMsg}
          </div>
        )}
      </div>

      <div className="card mb-4">
        <div className="card-header">从 Workspace 抽取技能</div>
        <div style={{ fontSize: '.82em', color: 'var(--ink-secondary)', marginBottom: 10 }}>
          粘贴会话链接或输入对话 ID，系统会从该对话的 workspace 自动扫描你创建的可学习技能
        </div>
        <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
          <input
            value={workspaceConversationId}
            onChange={e => setWorkspaceConversationId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleScanWorkspacePath(); }}
            placeholder="会话链接或对话 ID"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em', flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleScanWorkspacePath} disabled={workspaceLoading}>
            {workspaceLoading ? '扫描中...' : '扫描'}
          </button>
        </div>
        {workspaceCandidates.length > 0 && (
          <div className="mt-3" style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div className="flex-between" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.82em', fontWeight: 600 }}>
                Workspace 候选 {selectedWorkspacePaths.length}/{workspaceCandidates.length}
              </span>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={selectAllWorkspaceCandidates}>全选</button>
                <button className="btn btn-sm" onClick={() => setSelectedWorkspacePaths([])}>清空</button>
                <button className="btn btn-primary btn-sm" onClick={installSelectedWorkspaceSkills} disabled={workspaceLoading}>
                  安装选中
                </button>
              </div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {workspaceCandidates.map(skill => {
                const exists = skills.some(item => item.name === skill.name);
                const willOverwrite = exists || skill.installed === true;
                const sourcePath = candidatePath(skill);
                return (
                  <label
                    key={sourcePath}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 10,
                      alignItems: 'start',
                      padding: '9px 10px',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedWorkspacePaths.includes(sourcePath)}
                      onChange={() => toggleWorkspaceCandidate(sourcePath)}
                      style={{ width: 'auto', marginTop: 3 }}
                    />
                    <span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.82em', fontWeight: 600 }}>
                        {skill.name}
                      </span>
                      <span style={{ display: 'block', fontSize: '.75em', color: 'var(--ink-secondary)', marginTop: 2 }}>
                        {skill.description}
                      </span>
                      <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.68em', color: 'var(--ink-muted)', marginTop: 2 }}>
                        来自对话 {workspaceConversationLabel}
                      </span>
                      {skill.installedPath && (
                        <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.68em', color: 'var(--success)', marginTop: 2 }}>
                          已安装到 {skill.installedPath}
                        </span>
                      )}
                    </span>
                    {willOverwrite && <span className="badge badge-warning">将覆盖</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
        {workspaceMsg && (
          <div className="mt-2" style={{
            fontSize: '.8em',
            color: workspaceMsg.startsWith('✓') ? 'var(--success)' : workspaceMsg.includes('失败') ? 'var(--warning)' : 'var(--danger)',
          }}>
            {workspaceMsg}
          </div>
        )}
      </div>

      <div className="grid-3 mb-4">
        <div className="kpi-card">
          <div className="kpi-label">已安装</div>
          <div className="kpi-value">{skills.length}</div>
          <div className="kpi-sub">个技能</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">已启用</div>
          <div className="kpi-value" style={{ color: 'var(--success)' }}>{enabledCount}</div>
          <div className="kpi-sub">{skills.length - enabledCount} 个未启用</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">位置分布</div>
          <div className="kpi-value" style={{ fontSize: '.9em', fontFamily: 'var(--font-mono)' }}>
            用户 {skills.filter(s => s.location === 'user').length}
            · 项目 {skills.filter(s => s.location === 'project').length}
            · 插件 {skills.filter(s => s.location === 'plugin').length}
          </div>
        </div>
      </div>

      <div className="section-title">技能列表</div>
      {['user', 'project', 'plugin'].map(loc => {
        const group = skills.filter(s => s.location === loc);
        if (group.length === 0) return null;
        const locInfo = LOCATION_LABELS[loc];

        return (
          <div key={loc} className="mb-4">
            <div className="flex gap-2 mb-2" style={{ alignItems: 'center' }}>
              <span className="badge" style={{ background: locInfo.color + '20', color: locInfo.color }}>
                {locInfo.label}
              </span>
              <span style={{ fontSize: '.78em', color: 'var(--ink-muted)' }}>
                {loc === 'user' ? '技能背包安装目录' : loc === 'project' ? '.claude/skills/' : '插件自带'}
              </span>
            </div>
            <div className="grid-2">
              {group.map(skill => (
                <div
                  key={skill.name}
                  className="tool-card"
                  style={{
                    borderColor: skill.enabled ? 'var(--success)' : 'var(--border)',
                    opacity: skill.enabled ? 1 : .6,
                  }}
                >
                  <div className="flex-between">
                    <div>
                      <div className="tool-card-name" style={{ fontFamily: 'var(--font-mono)' }}>
                        {skill.name}
                      </div>
                      <div className="tool-card-desc">{skill.description}</div>
                      <div className="mt-1" style={{ fontSize: '.72em', color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}>
                        {skill.path}
                      </div>
                      {skill.learnedFromPublicSkillId && (
                        <div className="mt-2">
                          <span className="badge badge-info">公共学习 rev {skill.learnedFromPublicRevision || 1}</span>
                        </div>
                      )}
                      <div className="mt-2">
                        <span className={`badge ${(skillUsage.get(skill.name) || 0) > 0 ? 'badge-info' : 'badge-muted'}`}>
                          {skillUsage.get(skill.name) || 0} 个 Agent 使用
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2" style={{ flexDirection: 'column', alignItems: 'center' }}>
                      <StatusBadge status={skill.enabled ? 'success' : 'disabled'} label={skill.enabled ? '启用' : '禁用'} />
                      <button
                        className={`btn btn-sm ${skill.enabled ? 'btn-danger' : 'btn-primary'}`}
                        onClick={() => toggleSkill(skill.name)}
                      >
                        {skill.enabled ? '停用' : '启用'}
                      </button>
                      {canPublish && skill.location === 'user' && (
                        <button
                          className="btn btn-sm"
                          onClick={() => { void publishSkill(skill); }}
                          disabled={Boolean(publishingName)}
                        >
                          {publishingName === skill.name ? '发布中...' : '发布公共'}
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => { void deleteSkill(skill); }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
        </>
      )}
    </div>
  );
}
