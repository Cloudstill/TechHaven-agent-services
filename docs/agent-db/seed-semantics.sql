-- ============================================================================
-- Agent 平面数据层 · 语义层策展数据（manual curating, 对照已审查的 seed）
-- 依据：services/techhaven-mcp/src/semantics/mockProvider.ts（P0 人工策展版的 DB 镜像）
-- 说明：语义层数据靠人工低频维护；@全体 记得在改后端字段时同步此文件。
--       列名使用后端物理列名风格（snake_case）；create_time/update_time 对应接口的 createdAt/updatedAt。
-- 注意：本文件是 DEV/演示种子（org_id = 1），生产数据由后端运维策展后另行提供。
-- ============================================================================

-- ---------- 对象（semantic_objects） ----------
INSERT INTO semantic_objects (subject_table, biz_name, description) VALUES
  ('requirements', '需求', '研发需求工单：记录产品/平台要实现的功能或改进，沿 新建→开发→测试→完成→关闭 闭环流转。'),
  ('bugs',        '缺陷', '研发缺陷工单：记录平台功能异常，沿 新建→接受→处理→验证（可能复活）→关闭 闭环流转。'),
  ('tasks',       '任务', '研发任务工单：记录平台工程事务，沿 待办→进行中→完成→关闭 闭环流转。')
ON CONFLICT (subject_table) DO UPDATE SET biz_name = EXCLUDED.biz_name, description = EXCLUDED.description;

-- ---------- 字段（semantic_fields，三个对象共用同一套物理列序） ----------
-- 需求
INSERT INTO semantic_fields (object_id, column_name, biz_name, biz_description, example, sensitive)
SELECT o.id, f.column_name, f.biz_name, f.biz_description, f.example, f.sensitive
FROM (VALUES
  ('requirements', 'id',          '需求ID',      '需求记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。', NULL, FALSE),
  ('requirements', 'title',       '需求标题',    '一句话概括要做什么；关键词搜索主要匹配本字段。', '文章编辑器支持 Mermaid 图表导出为 PNG', FALSE),
  ('requirements', 'description', '需求描述',    '详细说明：背景、验收标准、约束条件。判断需求范围与改不改得动，以本字段为准。', NULL, FALSE),
  ('requirements', 'status',      '需求状态',    'new=新建（已登记待排期）| developing=开发中 | testing=测试中 | done=已完成（开发验收通过）| closed=已关闭（终止态）。只能按合法迁移推进，非法迁移会被状态机拒绝。', 'developing', FALSE),
  ('requirements', 'priority',    '优先级',      'high=高 | medium=中 | low=低。表达交付顺序期望，不影响状态流转。', 'high', FALSE),
  ('requirements', 'assignee',    '负责人',      '当前承接人的用户名；空串表示未指派。对未指派工单先确认归属，再做推进类操作。', 'chen', FALSE),
  ('requirements', 'creator',     '创建人',      '提出该需求的用户名。', 'chen', FALSE),
  ('requirements', 'create_time', '创建时间',    '需求登记时间，ISO 8601 UTC（对应接口字段 createdAt）。趋势口径的「窗口内新建」按本字段判定。', '2026-08-26T02:00:00.000Z', FALSE),
  ('requirements', 'update_time', '更新时间',    '最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。', '2026-08-27T09:30:00.000Z', FALSE)
) AS f(subject_table, column_name, biz_name, biz_description, example, sensitive)
JOIN semantic_objects o ON o.subject_table = f.subject_table
ON CONFLICT (object_id, column_name) DO UPDATE SET
  biz_name = EXCLUDED.biz_name,
  biz_description = EXCLUDED.biz_description,
  example = EXCLUDED.example,
  sensitive = EXCLUDED.sensitive;

-- 缺陷
INSERT INTO semantic_fields (object_id, column_name, biz_name, biz_description, example, sensitive)
SELECT o.id, f.column_name, f.biz_name, f.biz_description, f.example, f.sensitive
FROM (VALUES
  ('bugs', 'id',          '缺陷ID',      '缺陷记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。', NULL, FALSE),
  ('bugs', 'title',       '缺陷标题',    '一句话概括缺陷现象。', 'KaTeX 公式在暗色主题下对比度不足', FALSE),
  ('bugs', 'description', '缺陷描述',    '现象、复现步骤、期望结果与实际结果；动手修复前必读。', NULL, FALSE),
  ('bugs', 'status',      '缺陷状态',    'new=新建（待确认）| accepted=已接受（确认有效，进入处理队列）| processing=处理中（修复进行时）| verified=已验证（修复经回归确认）| reopened=已复活（验证未通过退回，需重新处理）| closed=已关闭（终止态）。new 不能直接跳到 verified，必须先 accepted。', 'processing', FALSE),
  ('bugs', 'priority',    '优先级',      'urgent=紧急 | high=高 | medium=中 | low=低。缺陷比需求/任务多一档 urgent，表示阻塞发布或核心功能不可用，应最优先处理。', 'urgent', FALSE),
  ('bugs', 'assignee',    '负责人',      '当前修复责任人的用户名；空串表示未指派（待认领）。', 'dev01', FALSE),
  ('bugs', 'creator',     '报告人',      '报告该缺陷的用户名。', 'dev02', FALSE),
  ('bugs', 'create_time', '创建时间',    '缺陷报告时间，ISO 8601 UTC（对应接口字段 createdAt）。', '2026-08-28T03:00:00.000Z', FALSE),
  ('bugs', 'update_time', '更新时间',    '最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。「缺陷解决时长」「缺陷复活率」等指标的窗口判定依赖状态迁移轨迹。', '2026-08-28T12:00:00.000Z', FALSE)
) AS f(subject_table, column_name, biz_name, biz_description, example, sensitive)
JOIN semantic_objects o ON o.subject_table = f.subject_table
ON CONFLICT (object_id, column_name) DO UPDATE SET
  biz_name = EXCLUDED.biz_name,
  biz_description = EXCLUDED.biz_description,
  example = EXCLUDED.example,
  sensitive = EXCLUDED.sensitive;

-- 任务
INSERT INTO semantic_fields (object_id, column_name, biz_name, biz_description, example, sensitive)
SELECT o.id, f.column_name, f.biz_name, f.biz_description, f.example, f.sensitive
FROM (VALUES
  ('tasks', 'id',          '任务ID',      '任务记录主键（组织内唯一）。对外一律以 hashId 编码串呈现（即各工具出参的 id 字段），agent 不得自行构造、猜测，也不能把编码串当数字使用。', NULL, FALSE),
  ('tasks', 'title',       '任务标题',    '一句话概括要做什么。', '升级 Vite 至 8.1 并验证构建产物', FALSE),
  ('tasks', 'description', '任务描述',    '任务约束与交付要点。', NULL, FALSE),
  ('tasks', 'status',      '任务状态',    'todo=待办 | doing=进行中 | done=已完成 | closed=已关闭（终止态）。只能按合法迁移推进。', 'doing', FALSE),
  ('tasks', 'priority',    '优先级',      'high=高 | medium=中 | low=低。', 'medium', FALSE),
  ('tasks', 'assignee',    '负责人',      '当前承接人的用户名；空串表示未指派。', 'chen', FALSE),
  ('tasks', 'creator',     '创建人',      '创建该任务的用户名。', 'chen', FALSE),
  ('tasks', 'create_time', '创建时间',    '任务登记时间，ISO 8601 UTC（对应接口字段 createdAt）。', '2026-08-23T02:00:00.000Z', FALSE),
  ('tasks', 'update_time', '更新时间',    '最近一次变更时间（状态迁移、编辑均会刷新），ISO 8601 UTC（对应接口字段 updatedAt）。', '2026-08-27T02:00:00.000Z', FALSE)
) AS f(subject_table, column_name, biz_name, biz_description, example, sensitive)
JOIN semantic_objects o ON o.subject_table = f.subject_table
ON CONFLICT (object_id, column_name) DO UPDATE SET
  biz_name = EXCLUDED.biz_name,
  biz_description = EXCLUDED.biz_description,
  example = EXCLUDED.example,
  sensitive = EXCLUDED.sensitive;

-- ---------- 指标（semantic_metrics，org 1） ----------
INSERT INTO semantic_metrics (org_id, name, caliber, sql_hint, owner) VALUES
  (1, '缺陷解决时长', 'verified − accepted（工作小时）', '按 bugs 表同会话内 [accepted 快照, verified 快照] 的 update_time 差值计；跨日须区分工作日（待后端口径确认）', NULL),
  (1, '缺陷复活率', '窗口内 reopened 数 / closed 数', '分母为 0 时输出 null（不计算），避免误读', NULL),
  (1, '需求吞吐', '窗口内进入 done 的需求数', '按 requirements 表 status 迁移轨迹计（窗口 = 最近 30 天）', NULL)
ON CONFLICT (org_id, name) DO UPDATE SET
  caliber = EXCLUDED.caliber,
  sql_hint = EXCLUDED.sql_hint;
