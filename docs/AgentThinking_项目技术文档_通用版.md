# AgentThinking 技术文档：面向企业知识库的证据控制型问答系统

## 1. 项目定位

AgentThinking 是一个面向企业知识库场景的智能问答与知识组织系统。它的目标不是简单做一个“把文件上传后让大模型回答”的聊天工具，而是构建一套**可检索、可引用、可校验、可审计**的知识问答系统。

在企业场景中，用户常常会问这类问题：

```text
这份制度里报销流程是什么？
这篇判决书中总金额由哪些部分构成？
某个项目失败的原因有哪些？
哪些事实支持这个结论？
某个结论有没有原文依据？
这些数字加起来是否和总数一致？
```

这些问题的难点在于，它们不仅要求模型“能回答”，还要求：

```text
回答必须来自原文；
不能漏掉关键事实；
不能把不同人物、不同事项混在一起；
金额、数量、时间线要能闭合；
没有依据时必须说明证据不足；
回答过程要能复盘。
```

因此，AgentThinking 的核心设计思想是：

> 先把文档变成可追踪的证据结构，再让模型基于证据回答，而不是让模型直接自由发挥。

这类系统属于 RAG，即 Retrieval-Augmented Generation，检索增强生成。RAG 的基本思想是：大模型回答前，先从外部知识库中检索相关资料，再把检索到的资料放入模型上下文中，让模型基于这些资料生成答案。

不过，AgentThinking 不止是普通 RAG。普通 RAG 通常是：

```text
用户问题 → 检索几个相关片段 → 模型回答
```

AgentThinking 的流程更接近：

```text
用户问题
 → 判断问题需要什么证据
 → 多轮检索原文、上下文、图谱和摘要
 → 抽取结构化证据
 → 判断证据是否充分
 → 做金额、数量、覆盖性校验
 → 基于证据生成答案
 → 保存证据包供审计
```

所以，它更准确的定位是：

> 一个证据控制型 RAG 系统。

---

## 2. 为什么不能只靠大模型直接回答？

大模型本质上是根据上下文预测下一个 token 的生成模型。它很擅长语言理解、总结、归纳和表达，但它并不天然知道企业内部文档里的具体内容。

如果直接把问题交给模型，会有几个风险。

### 2.1 没有材料时会凭经验回答

比如用户问：

```text
公司差旅报销标准是多少？
```

如果模型没有看到公司制度，它可能根据常见企业制度编出一个看似合理的答案。

### 2.2 材料太长时容易漏信息

如果一篇文书中有 21 个事实，模型可能只关注开头几项，忽略后面的细节。

例如：

```text
总额有 21 个来源；
模型只读到前 5 个来源；
却回答“全部来源如下”。
```

这种错误在长文档问答中很常见。

### 2.3 细节容易串线

长文档中经常有很多相似实体：

```text
杨某丙
杨某戊
杨某庚

张某丑
张某申
张某酉
```

如果系统没有强结构约束，模型可能把 A 的请托事项写成 B 的事项。

### 2.4 数字容易看似正确但内部不闭合

例如总金额能答对，但内部拆分错：

```text
总额：67.0196 万元
子项：22 万 + 13.8196 万 + 29 万
```

这里子项合计是 64.8196 万元，并不等于 67.0196 万元。

因此，企业知识库问答不能只依赖“模型会总结”，必须有一套证据控制机制。

---

## 3. 系统总体架构

AgentThinking 的核心流程可以分为七层：

```text
1. 文档导入与解析
2. 文档结构化索引
3. 上下文单元构建
4. 检索与图谱导航
5. EvidenceMemory 证据记忆
6. 回答生成与校验
7. EvidencePack 证据包审计
```

整体流程如下：

```text
原始文档
  ↓
解析为文本与结构
  ↓
构建 Document Tree
  ↓
生成 Chunk / Context Unit / Retrieval Unit
  ↓
建立全文索引、向量索引、摘要树、知识图谱
  ↓
用户提问
  ↓
问题规划
  ↓
多轮检索与证据抽取
  ↓
证据充分性判断
  ↓
数值闭合与引用校验
  ↓
生成答案
  ↓
保存 EvidencePack
```

可以把它类比成一个“智能审稿员”：

```text
文档解析：把材料拆开放好
索引构建：给每份材料贴标签
检索：找到可能相关的材料
证据抽取：从材料中摘出关键证据
充分性判断：判断材料够不够回答
闭合校验：检查数字是否对账
回答合成：基于证据写结论
证据包：保留审稿记录
```

---

## 4. 文档导入与解析

文档导入是整个系统的入口。系统需要支持多种资料类型，例如：

```text
Markdown
TXT
Word
PDF
企业制度文件
裁判文书
项目报告
技术文档
```

导入后，系统首先将文件转换为可处理的文本，并尽量保留文档中的结构信息，例如：

```text
标题
章节
段落
页码
表格
列表
编号
行号
```

这些结构非常重要。因为企业知识库中的很多答案并不是散落在一句话里，而是依赖章节、编号和上下文。

例如法律文书中常见结构：

```text
本院查明
（一）某甲相关事实
（二）某乙相关事实
（三）某丙相关事实
辩护意见
法院认为
判决如下
```

如果系统不知道“（一）（二）（三）”是并列事实单元，就很容易漏项或串项。

---

## 5. Document Tree：文档树

Document Tree 是系统理解文档结构的基础。

它把原始文档组织成一棵树：

```text
Document
 ├─ Section
 │   ├─ Paragraph
 │   │   ├─ Sentence
 │   │   └─ Sentence
 │   └─ Paragraph
 └─ Section
     └─ Paragraph
```

每个节点都保存：

```text
节点类型
父节点
子节点
顺序位置
标题路径
原文文本
摘要
前后相邻节点
来源 chunk
```

### 5.1 为什么需要文档树？

因为用户问问题时，答案经常需要“顺着文档结构找”。

例如用户问：

```text
这项事实有哪些证据支持？
```

系统不能只返回一句话，而应该能定位到：

```text
当前事实段
该事实下的证据段
相邻段落
所属章节
法院认定部分
```

Document Tree 让系统可以执行这些动作：

```text
读取当前节点
读取父节点
读取子节点
读取同一章节
读取相邻节点
读取当前节点之后的剩余节点
```

这比普通向量检索更可靠。

### 5.2 文档树和普通 chunk 的区别

普通 chunk 是“为了检索切出来的文本块”。

文档树是“为了理解文档结构建立的层级”。

可以这样理解：

```text
chunk 像碎纸片；
Document Tree 像装订好的目录和页码；
系统既要能找到碎纸片，也要知道碎纸片属于哪一章哪一节。
```

---

## 6. Chunk：基础文本片段

Chunk 是系统最基础的文本存储单位。

每个 chunk 保存：

```text
id
libraryId
versionId
parentChunkId
documentTreeNodeId
ordinal
headingPath
pageNumber
startLine / endLine
startChar / endChar
text
nodeType
```

Chunk 的作用是：

```text
作为向量检索对象
作为全文搜索对象
作为引用定位对象
作为图谱抽取依据
作为 EvidenceRow 的来源
```

### 6.1 为什么不能只用 chunk？

因为 chunk 通常有长度限制。太短会丢上下文，太长会影响检索精度。

例如一个事实段很长：

```text
请托事项
金额
收受方式
证人证言
书证
法院认定
```

如果按固定长度切，模型可能只看到“金额”，看不到“法院为什么认定”。

所以系统在 chunk 之上又引入了 Context Unit 和 Retrieval Unit。

---

## 7. Context Unit：理解用的上下文单元

Context Unit 可以理解为“较完整的语义证据包”。

它通常由同一文档树节点下的相关 chunk 组成，目标是保留一个相对完整的上下文。

一个 Context Unit 包含：

```text
sourceNodeIds
primarySourceNodeId
sourceRange
headingPath
displayHeadingPath
ordinal
text
blocks
retrievalUnitIds
estimatedTokens
boundaryReason
```

### 7.1 Context Unit 解决什么问题？

它解决的是：

```text
检索命中的片段太小，单独看不懂。
```

例如检索命中一句话：

```text
共计折合人民币67.0196万元。
```

这句话本身不够。系统需要知道：

```text
是谁给的？
包括哪些财物？
为什么给？
对应哪个事实编号？
这笔钱是否计入总额？
```

Context Unit 的作用就是把这句话放回完整上下文中。

### 7.2 Context Unit 与 Chunk 的关系

```text
Chunk：更小，方便定位和引用
Context Unit：更大，方便理解和证据完整性
```

系统问答时通常会先通过检索找到 chunk 或 retrieval unit，再回到 context unit 中读取更完整的文本。

---

## 8. Retrieval Unit：检索用的小窗口

如果 Context Unit 很长，直接拿它做向量检索效果会下降。因为一个长文本里可能包含多个主题，向量会变得不够精准。

因此系统会从 Context Unit 中切出 Retrieval Unit。

```text
Context Unit：完整语义单元
Retrieval Unit：检索窗口
```

Retrieval Unit 负责被搜索，Context Unit 负责被理解。

例如一个 Context Unit 有 6000 字，系统可以切成多个检索窗口：

```text
Retrieval Unit 1：前 1200 字
Retrieval Unit 2：中间 1200 字
Retrieval Unit 3：后面 1200 字
```

窗口之间会有一定 overlap，避免关键信息刚好被切断。

这种设计兼顾了两个目标：

```text
检索时要精确；
回答时要完整。
```

---

## 9. Summary Tree：摘要树

除了原文结构，系统还会构建摘要树。

摘要树的作用不是直接作为最终证据，而是辅助导航。

它可以帮助系统快速判断：

```text
这篇文档有哪些主题？
哪些章节可能相关？
某个问题应该去哪个部分查？
```

摘要树通常包含：

```text
paragraph summary
section summary
document summary
cluster summary
```

### 9.1 摘要树不能代替原文

摘要树是压缩信息。压缩就意味着可能丢细节。

所以系统应当遵守一个原则：

> 摘要树负责导航，最终事实依据必须回到原文 chunk、context unit 或 EvidenceRow。

例如问：

```text
受贿金额是多少？
```

不能只根据摘要回答，必须回到原文金额证据。

---

## 10. 知识图谱：概念、事实和关系的导航层

系统会从文档中抽取概念、声明和关系，形成知识图谱。

图谱节点可以表示：

```text
人物
机构
项目
事实
主张
制度条款
争议点
结论
```

图谱关系可以表示：

```text
支持
解释
依赖
例证
相关
矛盾
```

### 10.1 知识图谱的作用

知识图谱不是为了替代原文，而是为了辅助检索和导航。

例如用户问：

```text
为什么法院认为这笔设备款构成受贿？
```

系统可以通过图谱找到：

```text
设备款
黄胜
黄某寅
杨某丙
受贿认定
辩护意见
法院说理
```

然后再回到这些节点引用的原文 chunk 中取证。

### 10.2 图谱必须受证据约束

图谱中的节点和关系必须有 evidenceChunkIds，也就是必须能回到原文。

否则图谱会变成模型自由发挥的结果。

系统对图谱关系设置了规则，例如：

```text
不能只因为两个词同时出现就建立强关系；
强关系必须有直接证据；
关系方向要正确；
矛盾关系必须同一范围内才成立；
不确定时应降级为 related_to 或不建立关系。
```

---

## 11. 用户提问后的完整问答流程

当用户输入问题后，系统不会马上回答，而是进入一套证据控制流程。

完整流程如下：

```text
用户问题
  ↓
问题分析 Question Planning
  ↓
初始检索 Seed Retrieval
  ↓
创建 EvidenceMemory
  ↓
抽取 EvidenceRows
  ↓
规划检索步骤
  ↓
执行多轮检索
  ↓
判断证据充分性
  ↓
如有缺口，继续 gap retrieval
  ↓
做数值闭合与引用校验
  ↓
合成答案
  ↓
校验答案
  ↓
保存 EvidencePack
```

---

## 12. Question Planning：先判断问题类型

不同问题需要不同强度的证据。

例如：

```text
“这篇文档讲了什么？”
```

这是摘要类问题，要求相对低。

但：

```text
“1223.922153万元由哪些来源构成？”
```

这是高风险问题，需要：

```text
穷尽所有来源；
抽取结构化金额；
计算分项合计；
和总额闭合；
引用原文；
不能漏项。
```

因此系统会先分析问题，生成 Question Plan。

Question Plan 通常包括：

```text
questionType
requiresExhaustiveEvidence
requiresStructuredEvidence
requiresNumericalReconciliation
requiresSourceQuotes
requiresTimelineCompleteness
requiresEntityCoverage
allowedPartialAnswer
answerMustExposeGaps
evidenceTargets
keyEntities
expectedEvidenceTypes
riskLevel
```

### 12.1 常见问题类型

```text
normal：普通事实问答
summary：摘要
exhaustive_list：穷尽列表
numerical_aggregation：金额或数量汇总
timeline：时间线
entity_relation：实体关系
causal_explanation：原因解释
claim_support：主张支持
critique：批判分析
comparison：比较
mixed：混合型问题
```

Question Plan 决定后续检索策略和回答约束。

---

## 13. EvidenceMemory：问答过程中的证据仓库

EvidenceMemory 是系统回答问题时临时构建的证据仓库。

它保存：

```text
用户问题
问题计划
已收集的 chunks
context units
retrieval units
context blocks
图谱节点
图谱关系
文档树节点
父子 chunk
摘要节点
EvidenceRows
引用 chunk ids
检索历史
检索轨迹
当前发现
证据缺口
充分性判断历史
```

可以把 EvidenceMemory 理解成：

```text
这一次问答的案卷。
```

它不是永久知识库，而是针对某个问题临时组织出来的证据集合。

### 13.1 为什么需要 EvidenceMemory？

因为多轮问答不是一次检索就结束。

系统需要知道：

```text
已经找过什么？
已经抽到什么证据？
哪些金额已经计入？
还缺哪些部分？
上次为什么判断证据不足？
下一步应该继续查哪里？
```

这些信息都保存在 EvidenceMemory 中。

---

## 14. EvidenceRow：结构化证据行

EvidenceRow 是系统从原文中抽取出的结构化证据。

它可以表示：

```text
事实
金额
日期
实体关系
主张
引用
其他证据
```

一条 EvidenceRow 通常包含：

```text
rowId
evidenceType
claimText
structuredValue
sourceEntity
targetEntity
relationType
evidenceChunkId
evidenceQuote
confidence
countedInAnswer
dedupeKey
warnings
```

### 14.1 为什么要有 EvidenceRow？

因为直接把原文交给模型总结，容易漏项。

EvidenceRow 相当于把原文中的关键事实变成数据库记录。

例如原文：

```text
收受杨某丙财物共计556.782683万元。
```

可以抽成：

```json
{
  "evidenceType": "amount",
  "sourceEntity": "杨某丙",
  "structuredValue": {
    "normalizedAmountWan": 556.782683,
    "role": "itemized_value"
  },
  "evidenceQuote": "收受杨某丙财物共计556.782683万元"
}
```

这样后续系统可以做：

```text
排序
求和
去重
闭合校验
引用回溯
```

### 14.2 EvidenceRow 和引用

每条 EvidenceRow 都必须绑定：

```text
evidenceChunkId
evidenceQuote
```

也就是说，结构化证据不能凭空产生，必须能回到原文。

这就是系统“可审计”的基础。

---

## 15. 多轮检索：从一次 top-k 到持续查缺口

普通 RAG 很多时候只做一次检索：

```text
问题 → topK → 回答
```

这对简单问题可以，但对复杂文档不够。

AgentThinking 的检索是多轮的。

系统有多种检索工具：

```text
semanticSearchChildChunks
fullTextSearchChildChunks
retrieveParentChunks
retrieveDocumentTreeNodes
retrieveSectionSubtree
retrieveSiblingNodes
retrieveRemainingNodesAfter
retrieveSummaryTree
graphSearch
graphExpand
retrieveEvidenceForGraphNodes
```

这些工具分别解决不同问题：

| 工具 | 作用 |
|---|---|
| 语义搜索 | 找意思相近的片段 |
| 全文搜索 | 找包含关键词的片段 |
| 读取父级 chunk | 回到更完整上下文 |
| 读取同章节 | 补全同一事实单元 |
| 读取相邻节点 | 找前后文 |
| 读取后续节点 | 补全列表后半段 |
| 摘要树检索 | 找相关章节 |
| 图谱搜索 | 找相关概念、人物、关系 |
| 图谱扩展 | 顺着关系继续找证据 |

### 15.1 Gap Retrieval：查缺口

系统每轮检索后都会判断证据是否足够。

如果发现：

```text
缺少分项证据
有总额但没有明细
分项合计不闭合
实体覆盖不足
时间线不完整
缺少原文引用
```

它会继续检索。

例如：

```text
已经找到总额 1223.922153 万元
只找到 5 个来源
分项合计远小于总额
```

系统应判断：

```text
证据不足，需要继续读取后续事实编号。
```

这就是 gap retrieval。

---

## 16. 数值闭合：把问答变成可对账

对企业知识库来说，很多问题都涉及数字：

```text
金额
数量
比例
日期
次数
总计
分项
```

系统必须能够区分：

```text
声明总额
分项金额
组成部分金额
背景金额
争议金额
排除金额
近似金额
```

### 16.1 总额级闭合

系统会计算：

```text
declaredTotal = 文档声明总额
itemizedSum = 已抽取分项金额合计
difference = declaredTotal - itemizedSum
closed = difference 是否接近 0
```

如果不闭合，系统不能声称完整。

例如：

```text
声明总额：1223.922153 万元
已列分项：617.496083 万元
差额：606.42607 万元
```

这时必须继续查，或明确暴露缺口。

### 16.2 为什么闭合很重要？

因为它能防止最危险的错误：

```text
答案看起来很完整；
实际上漏掉了一大半。
```

数字闭合就像财务对账。账不平，就不能出最终结论。

---

## 17. 证据充分性判断

系统不是找到一点证据就回答，而是会判断证据是否足够。

充分性判断会考虑：

```text
是否有原文引用
是否有结构化证据
是否满足问题要求
是否覆盖所有实体
是否覆盖完整列表
金额是否闭合
时间线是否完整
是否还存在明显缺口
```

判断结果可能是：

```text
sufficient：证据充分
needs_gap_retrieval：需要继续查
failed_reconciliation：数值不闭合
insufficient_context：上下文不足
partial_answer_only：只能部分回答
```

如果不是 sufficient，答案就必须保守。

---

## 18. 回答生成：模型只基于 EvidenceMemory 作答

当证据收集完成后，系统会让模型基于 EvidenceMemory 生成答案。

此时模型被限制：

```text
只能使用 EvidenceMemory 中的证据；
不能暗示已穷尽，除非证据充分；
如果证据不足，必须说明缺口；
如果数值不闭合，必须说明总额、分项合计和差额；
如果需要引用，必须给出原文级证据。
```

这一步不是让模型自由发挥，而是让模型把已经整理好的证据表达成用户能读懂的答案。

---

## 19. 回答校验与重写

答案生成后，系统还会进行校验。

主要校验包括：

```text
需要引用时，答案是否包含可核对引用；
证据不足时，是否使用了“全部、完整、无遗漏”等过度词；
数值不闭合时，是否披露差额；
存在缺口时，是否明确说明证据不足；
答案是否应该降级为保守回答。
```

如果校验失败，系统会要求模型重写。

如果重写仍不满足要求，系统会输出 guarded answer，即保守答案。

### 19.1 保守答案的意义

企业知识库问答不能追求“每次都给一个漂亮答案”。

更重要的是：

```text
知道就是知道；
不知道就说不知道；
证据不够就暴露证据不够。
```

这比“看起来很完整但实际胡编”可靠得多。

---

## 20. EvidencePack：答案背后的证据包

每次问答完成后，系统会保存 EvidencePack。

EvidencePack 包含：

```text
问题
证据包 schema 版本
使用的索引类型
检索轨迹
EvidenceRows
引用信息
证据充分性状态
数值闭合结果
上下文覆盖情况
```

EvidencePack 的意义是：

```text
让答案可复盘；
让错误可定位；
让评测可自动化；
让用户或开发者知道答案来自哪里。
```

如果答案错了，开发者可以检查：

```text
是检索没找到？
是 EvidenceRow 没抽出来？
是 sufficiency 判断错了？
是合成阶段串人？
是上下文被截断？
是闭合校验粒度不够？
```

这对系统迭代非常重要。

---

## 21. 上下文管理与截断策略

大模型有上下文长度限制，不能无限制塞入所有文档。因此系统必须管理上下文。

AgentThinking 采用多层上下文策略：

```text
小窗口用于检索；
大单元用于理解；
证据行用于结构化；
证据记忆用于问答；
证据包用于审计。
```

### 21.1 为什么必须截断？

因为如果把所有内容都塞给模型，会有问题：

```text
超过模型上下文限制；
调用成本高；
响应慢；
无关信息干扰判断；
模型注意力被稀释。
```

所以系统会限制：

```text
每个检索窗口大小；
每轮检索数量；
最多检索轮数；
最终进入模型的证据条数；
最终答案输出长度。
```

### 21.2 截断带来的风险

截断也会带来风险：

```text
同一事实被切开；
金额和解释分离；
人物和事项分离；
只保留前半段，后半段证据丢失；
最终合成时看不到全部 EvidenceRows。
```

因此，系统需要不断在两个目标之间平衡：

```text
检索效率
vs
证据完整性
```

对高风险问题，系统应当倾向于提高上下文预算和检索轮数。

---

## 22. 高风险问题的处理原则

以下问题属于高风险问题：

```text
列出全部
每一笔
总额是多少
由哪些来源构成
是否闭合
证据有哪些
为什么法院这样认定
哪些事项没有办成
哪些金额不能计入
```

这类问题必须使用更严格策略：

```text
要求结构化证据；
要求原文引用；
要求覆盖所有相关事实；
要求数值闭合；
要求暴露缺口；
不能只依赖摘要；
不能只依赖图谱；
不能只检索一次。
```

尤其是金额和穷尽列表类问题，必须优先保证：

```text
不漏项；
不误算；
不把背景金额计入；
不把不同事实的人物和事项串联。
```

---

## 23. 当前系统最适合的场景

AgentThinking 当前特别适合以下场景：

### 23.1 企业制度问答

例如：

```text
报销标准是什么？
审批流程是什么？
某类费用是否允许？
制度中有哪些例外情况？
```

### 23.2 长文档事实问答

例如：

```text
这篇文书的核心事实是什么？
某个项目失败的原因有哪些？
有哪些证据支持该结论？
```

### 23.3 金额和清单类问答

例如：

```text
总金额由哪些部分构成？
每一项金额是多少？
分项加起来是否等于总额？
```

### 23.4 证据审计型问答

例如：

```text
这句话有没有原文依据？
这个结论是否被文档支持？
哪些证据相互矛盾？
```

### 23.5 图谱导航型问答

例如：

```text
某个人物和哪些事项有关？
某个项目涉及哪些机构？
某个争议点和哪些证据相关？
```

---

## 24. 当前系统的边界

系统虽然比普通 RAG 更可靠，但仍有边界。

### 24.1 不能保证每次都完整覆盖超长文档

如果文档很长、事实很多，系统仍可能因为上下文限制、检索轮数限制或抽取失败而漏掉部分证据。

### 24.2 总额闭合不等于子项闭合

系统可以检查：

```text
所有分项金额是否等于总额
```

但如果需要更细粒度，还应检查：

```text
每个事实内部的子项金额是否等于该事实金额
```

### 24.3 实体关系仍需要更强绑定

如果文档中人物名称相似，系统需要确保：

```text
请托人
受益人
请托事项
收受金额
事实编号
```

绑定在同一个事实单元内。

否则可能出现实体串线。

### 24.4 摘要和图谱不能替代原文

摘要和图谱适合导航，但最终高风险答案必须回到原文证据。

---

## 25. 推荐的核心数据结构：FactUnit

为了进一步提高长文档事实问答的可靠性，系统应当在 EvidenceRow 之上增加 FactUnit。

FactUnit 是“事实单元”。

对判决书、审计报告、事故报告、项目复盘这类材料，事实单元通常比单条 EvidenceRow 更自然。

一个 FactUnit 可以设计为：

```ts
interface FactUnit {
  factIndex: string;
  title: string;
  sourceEntity: string;
  organization?: string;
  beneficiaries: string[];
  requestMatters: RequestMatter[];
  totalAmountWan?: number;
  components: AmountComponent[];
  evidenceQuotes: EvidenceQuote[];
  reasoningQuotes: EvidenceQuote[];
  sourceChunkIds: string[];
  confidence: number;
}
```

### 25.1 FactUnit 解决什么问题？

它解决三类问题：

第一，防止漏项。

```text
每个事实编号都必须有一个 FactUnit。
```

第二，防止串人。

```text
请托人、受益人、请托事项必须绑定在同一个 FactUnit 中。
```

第三，支持子项闭合。

```text
FactUnit.totalAmount = sum(FactUnit.components)
```

### 25.2 FactUnit 和 EvidenceRow 的关系

```text
EvidenceRow：单条证据
FactUnit：多条 EvidenceRow 组成的事实单元
```

例如：

```text
FactUnit：蔡某甲相关事实
 ├─ EvidenceRow：总额 67.0196 万元
 ├─ EvidenceRow：现金 22 万元
 ├─ EvidenceRow：美元 2 万元
 ├─ EvidenceRow：购物卡 29 万元
 ├─ EvidenceRow：请托事项：免罚款、商业贷款、税务稽查、高尔夫球场
 └─ EvidenceRow：相关证据和法院认定
```

---

## 26. 推荐的校验机制

系统应当有三层校验。

### 26.1 文档级闭合

检查：

```text
所有事实单元金额合计 = 文档声明总额
```

适合回答：

```text
总金额由哪些来源构成？
```

### 26.2 事实单元级闭合

检查：

```text
某个事实单元内部组件合计 = 该事实单元总额
```

适合回答：

```text
蔡某甲这 67.0196 万元由哪些财物构成？
```

### 26.3 答案声明级校验

把最终答案拆成声明：

```text
杨某丙之弟职务晋升
张某丑朋友之女报考山东警察学院
蔡某甲美元2万元折合16.0196万元
```

逐条检查是否有同一 FactUnit 和原文引用支持。

如果没有支持，就不能输出。

---

## 27. 评测体系

要判断系统是否真正可用，不能只看回答“像不像”，而要建立 golden test。

一个好的测试集应覆盖：

```text
普通事实问答
摘要问答
穷尽列表
金额汇总
子项拆分
实体关系
时间线
证据支持
反驳与争议
无法回答场景
```

每个问题应检查：

```text
答案是否正确
是否漏项
是否引用原文
是否数字闭合
是否误把背景金额计入
是否串人
是否暴露缺口
```

### 27.1 示例评测问题

```text
1. 文档核心事实是什么？
2. 总金额是多少？
3. 总金额由哪些来源构成？
4. 每一项金额是否与总额闭合？
5. 最大一笔是什么？
6. 某一项内部由哪些子项构成？
7. 哪些事项没有办成但仍被认定？
8. 哪些事实通过亲属收受？
9. 法院为什么驳回某项辩护意见？
10. 哪些金额是背景利益，不能计入总额？
```

---

## 28. 系统设计原则总结

AgentThinking 的技术设计可以总结为八条原则。

### 原则一：原文优先

所有高风险答案必须回到原文。

### 原则二：检索不是答案，只是找材料

检索结果不能直接等于答案，必须经过证据抽取和充分性判断。

### 原则三：摘要用于导航，不用于最终定案

摘要可以帮助找方向，但最终事实必须引用原文。

### 原则四：图谱用于扩展，不用于凭空推断

图谱关系必须有证据支持。

### 原则五：数字必须闭合

金额、数量、比例类问题必须尽量对账。

### 原则六：证据不足必须暴露

不能在证据不足时声称“全部、完整、无遗漏”。

### 原则七：复杂问题需要多轮检索

一次 top-k 不足以回答长文档穷尽问题。

### 原则八：答案必须可审计

每次回答都应该能追溯到 EvidencePack。

---

## 29. 一句话总结

AgentThinking 是一个面向企业知识库的证据控制型 RAG 系统。

它的核心不是让大模型直接读文档后回答，而是：

```text
把文档组织成结构；
把结构转化为证据；
把证据放入问答记忆；
用校验机制约束回答；
让每个答案都能追溯、复盘和改进。
```

它真正解决的问题是：

```text
企业知识库问答不能只追求“答得像”，
而要追求“答得有依据、可核查、可闭合、可审计”。
```

---

## 参考资料

1. Lewis et al., *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*, 2020.
2. Asai et al., *Evidentiality-guided Generation for Knowledge-Intensive NLP Tasks*, 2021.
3. Jiang et al., *RAS: Retrieval-And-Structuring for Knowledge-Intensive LLM Generation*, 2025.
4. Mermaid Documentation / Mermaid text-based diagramming syntax.
