# 总览「功能宇宙」→ 真实银河系 3D — 设计文档

- 日期:2026-07-03
- 范围:仅 `dashboard/src/components/CapabilityUniverse.tsx` 内部重写(+ 少量新工具文件、CSS 微调)
- 状态:已确认设计,待写实现计划

## 0. 目标与边界

**目标**:把总览页「功能宇宙」从"10 颗虚构行星绕单恒星"改为**遵循物理规律的真实银河系视角**——
旋臂、核球、恒星群、尘埃带,10 个功能模块化为旋臂上的 10 颗可交互亮星。

**边界(不改的东西)**:
- `Overview.tsx` 与 `SECTIONS` 数据结构、`CapabilityUniverse` 对外接口(`{ sections }`)零改动
- `CosmicBackground.tsx`、`utils/planet.ts` 不动(登录页背景还在用 `makePlanetTexture`)
- 无 WebGL 时的卡片降级分支原样保留
- `planet-tag` 引线标签的 DOM 结构与 CSS 体系保留(最多微调引线长度等细节)

## 1. 场景结构

`CapabilityUniverse.tsx` 内部场景由五部分组成:

| 部件 | 实现 | 数量/开销 |
|---|---|---|
| GalaxyPoints | 单个 `THREE.Points` + 自定义 ShaderMaterial,全部盘面恒星 | 1 draw call |
| DustLanes | 程序生成(canvas)暗棕色噪声 sprite,沿旋臂内缘遮光 | 4–8 个 sprite |
| CoreGlow | 核球暖色径向渐变光晕 sprite(叠加混合) | 1–2 个 |
| ModuleStars | 10 颗功能亮星:模块色 glow+四芒星芒 sprite + 不可见 hit 球 | 10 组 |
| FarField | 远景背景星,球壳分布的小型 `THREE.Points` | 1 draw call |

相机:OrbitControls,初始约 30° 俯角 3/4 视角看银盘;保留自动旋转(autoRotate)、
阻尼、缩放范围限制、极角限制(不许钻到正侧面穿模)。

新增工具文件 `dashboard/src/utils/galaxy.ts`:恒星分布采样、光谱型→黑体色温 RGB、
sprite 贴图(星芒/光晕/尘埃/核球)的 canvas 生成函数。`CapabilityUniverse.tsx` 保持
"编排 + 交互"职责,生成逻辑归 `galaxy.ts`。

## 2. 物理模型

「遵循物理规律」落在以下可实现的点上(数值取银河系实测量级,允许为观感微调):

- **恒星分布**:指数盘 `ρ ∝ e^(-r/h)`(标长 h ≈ 盘半径/4) + 中心 3D 高斯核球
  (半径 ≈ 盘半径/6,厚度大于薄盘);垂直方向高斯薄盘,标高随半径外扩(flaring)。
- **旋臂**:对数螺旋密度波,2 条主臂 + 2 条弱臂,螺距角约 12°;恒星在臂附近
  **概率增强**(高斯扰动)而非钉死在臂上。
- **恒星颜色与大小**:按光谱型真实丰度采样(M≈76%、K≈12%、G≈8%、F≈3%、A≈0.6%、
  B/O 稀有),光谱型 → 黑体色温 → RGB;蓝星亮而大、红矮星暗而小,点缀少量红巨星。
  为观感对可见性做适度加权(纯真实丰度整体过暗),加权系数在 galaxy.ts 内注明。
- **差速自转**:平坦自转曲线 `v(r) ≈ v₀`(核内近似刚体转动 `v ∝ r`),即角速度
  内快外慢;**在顶点 shader 中按每颗星的半径 + uniform time 计算角度偏移**,CPU 零开销。
  页面停留时长内旋臂缠绕不可感知,不做密度波 pattern-speed 分离。
- **尘埃带**:暗色半透明 sprite 置于旋臂内缘(对应真实旋臂结构中尘埃位于恒星形成区内侧),
  normal blending 遮光;每个尘埃 sprite 按自身半径取 ω(r) 绕银心公转(CPU 侧逐帧算,量小),
  与所在半径的恒星流速一致。
- **闪烁**:shader 内按星编号做微弱亮度扰动(大气闪烁观感);`prefers-reduced-motion`
  时关闭自转与闪烁。

## 3. 模块亮星与交互

- 10 颗亮星按 `sections` 顺序**沿主旋臂由内向外**错开分布(半径 + 沿臂角度均错开,
  避免标签重叠);位置由确定性函数生成(同一 sections 每次渲染位置一致,不随机跳)。
- 每颗亮星 = 模块色径向光晕 + 四芒星芒 canvas 贴图的 sprite,外挂放大的不可见
  `THREE.Mesh` 球体做 raycast 命中区(命中区半径明显大于视觉星点,保证易点)。
- 交互逻辑照搬现版:pointermove raycast → hover 时 sprite 放大 ~1.4x、标签 `is-hover`、
  光标变 pointer;click 导航 `section.path`;标签为现有 `planet-tag`(罗马编号 + 名称 +
  hover 出描述),每帧投影跟随亮星位置,`proj.z < 1` 控制可见性。
- 亮星随银河差速自转缓慢移动(与星场同一 ω(r),在 CPU 侧对 10 颗星逐帧算,量小)。

## 4. 性能自适应

- **三档**:
  - 桌面高:≈100k 盘面恒星 + ≈5k 远景星 + 8 尘埃 sprite
  - 桌面低/平板:≈50k,尘埃 6 个
  - 移动:≈25k,尘埃 4 个
- **判档**:初始按 `pointer: coarse`、屏宽、`devicePixelRatio` 取档;运行头 ~60 帧
  实测 FPS(< 40 则降一档,重建星场一次为限)。
- **不引入后处理管线**(bloom 用 sprite 光晕近似),星场始终 1 draw call。
- 保留现版机制:`visibilitychange` 暂停 RAF、`ResizeObserver`、卸载时 geometry/material/
  texture 全量 dispose、`prefers-reduced-motion` 降级。
- 无 WebGL:现有卡片列表降级分支不动。

## 5. 验收标准

1. 总览页「功能宇宙」呈现可旋转缩放的旋臂银河:核球更亮更暖、旋臂清晰、尘埃带可辨、
   恒星颜色有蓝白黄红层次、整体差速旋转(内圈明显快于外圈)。
2. 10 个模块亮星带引线标签,hover 放大 + 出描述,click 正确跳转;标签不常态互相遮挡。
3. 桌面 Chrome 满帧(≈60fps),移动端不低于 ~30fps(降档生效)。
4. 切后台暂停渲染;组件卸载无 WebGL 泄漏警告;`prefers-reduced-motion` 时画面静止但可交互。
5. 无 WebGL 环境仍显示卡片列表。
6. 登录页(CosmicBackground)与其他页面视觉与行为无任何变化。

## 6. 风险与取舍

- **旋臂缠绕**:差速自转长时间运行会把"出生在臂上"的恒星拖离旋臂——接受,页面停留
  时长内不可感知;不实现 pattern-speed 分离(YAGNI)。
- **10 亮星与 10 模块的隐喻**:从"行星=模块"变为"亮星=模块",少了行星贴图的个性,
  靠模块色 + 星芒 + 罗马编号维持辨识度。
- **低端移动设备**:2.5 万粒子 + FPS 动态降档兜底;最坏情况观感变稀疏但不卡死。
