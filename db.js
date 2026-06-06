const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'contract.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const VECTORS_DIR = path.join(DATA_DIR, 'vectors');
if (!fs.existsSync(VECTORS_DIR)) {
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
}

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let db = null;

async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    db.run(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '⚖️',
            description TEXT,
            contract_type TEXT DEFAULT 'general',
            system_prompt TEXT,
            knowledge_base_ids TEXT DEFAULT '[]',
            review_focus TEXT DEFAULT '[]',
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            contract_type TEXT,
            document_count INTEGER DEFAULT 0,
            chunk_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            knowledge_base_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT,
            file_size INTEGER,
            chunk_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS document_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            chunk_text TEXT NOT NULL,
            chunk_index INTEGER,
            embedding_status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER NOT NULL,
            prompt_content TEXT,
            version_note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    initializeDefaultAgents();
    saveDatabase();
    
    return db;
}

function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

function initializeDefaultAgents() {
    const result = db.exec("SELECT COUNT(*) as count FROM agents");
    const count = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
    
    if (count > 0) return;

    const defaultAgents = [
        {
            name: '通用合同审查',
            icon: '⚖️',
            description: '适用于所有类型合同的基础审查，涵盖违约责任、付款条款、争议解决等核心审查维度',
            contract_type: 'general',
            system_prompt: `你是一位专业的合同审查律师。请对用户提供的合同文本进行全面审查，并严格按以下JSON格式返回结果：

首先判断用户提供的内容是否为合同或合同相关文档。如果内容明显不是合同（如小说、新闻、代码、普通对话等），请返回：
{"error": "NOT_CONTRACT", "message": "抱歉，无法审查非合同相关的内容"}

如果内容是合同或合同相关文档，请按以下格式返回：
{
  "summary": "合同整体评价（一句话）",
  "risks": [
    {
      "level": "high/medium/low",
      "clause": "涉及条款（直接从原文复制，至少15个字）",
      "reason": "风险原因",
      "suggestion": "修改建议"
    }
  ],
  "key_terms": ["关键条款1", "关键条款2"],
  "overall_score": 75
}

审查维度包括：违约责任是否对等、知识产权归属是否明确、保密条款是否完整、争议解决方式是否合理、付款条款是否明确、合同期限与解除条件是否清晰。

风险等级说明：
- high：高风险，可能导致重大经济损失或法律纠纷
- medium：中风险，需要关注但影响相对较小
- low：低风险，建议优化但不是必须

请只返回JSON，不要返回任何其他内容。`,
            knowledge_base_ids: '[]',
            review_focus: '["违约责任对等性","付款条款明确性","争议解决方式","保密条款完整性","合同期限与解除条件"]',
            is_active: 1,
            sort_order: 0
        },
        {
            name: '物权合同审查',
            icon: '🏠',
            description: '专注于房产买卖、土地转让、抵押合同等物权类合同的审查',
            contract_type: 'property',
            system_prompt: `你是一位专注于物权类合同的专业审查律师。请对用户提供的物权类合同（如房产买卖、土地转让、抵押合同等）进行专业审查。

审查重点：
1. 权属清晰性：确认标的物权属是否清晰，是否存在共有、查封、抵押等情况
2. 登记条款：确认过户登记、变更登记的时限和责任分配
3. 优先购买权：是否存在优先购买权人，是否已放弃优先购买权
4. 交付条款：交付条件、交付时间、风险转移时点
5. 价款支付：付款方式、付款节点、资金监管安排
6. 税费承担：各项税费的承担方是否明确
7. 违约责任：逾期交房、逾期付款、权属瑕疵等违约责任

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["权属清晰性","登记条款","优先购买权","交付条款","税费承担"]',
            is_active: 1,
            sort_order: 1
        },
        {
            name: '金融合同审查',
            icon: '💰',
            description: '专注于借款、担保、融资租赁等金融类合同的审查',
            contract_type: 'financial',
            system_prompt: `你是一位专注于金融类合同的专业审查律师。请对用户提供的金融类合同（如借款合同、担保合同、融资租赁合同等）进行专业审查。

审查重点：
1. 利率合规性：利率是否超过法定上限，利息计算方式是否明确
2. 担保效力：担保方式、担保范围、担保期限是否合法有效
3. 违约责任：逾期还款、提前到期、加速到期的条款是否合理
4. 债权转让：是否允许债权转让，转让通知方式
5. 费用承担：手续费、服务费、律师费等费用承担
6. 争议解决：管辖法院或仲裁机构是否明确
7. 放款条件：放款前提条件是否合理

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["利率合规性","担保效力","违约责任","债权转让","费用承担"]',
            is_active: 1,
            sort_order: 2
        },
        {
            name: '建设工程合同审查',
            icon: '🏗️',
            description: '专注于工程承包、设计、监理等建设工程类合同的审查',
            contract_type: 'construction',
            system_prompt: `你是一位专注于建设工程类合同的专业审查律师。请对用户提供的建设工程合同（如施工合同、设计合同、监理合同等）进行专业审查。

审查重点：
1. 工期条款：开工日期、竣工日期、工期顺延条件
2. 质量标准：工程质量标准、验收标准、质保期限
3. 付款节点：预付款、进度款、结算款的比例和支付条件
4. 变更签证：工程变更的程序、签证确认方式
5. 竣工结算：结算方式、结算期限、审计条款
6. 保修责任：保修范围、保修期限、保修金返还
7. 安全责任：安全生产责任划分

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["工期条款","质量标准","付款节点","变更签证","竣工结算","保修责任"]',
            is_active: 1,
            sort_order: 3
        },
        {
            name: '服务合同审查',
            icon: '📋',
            description: '专注于咨询、外包、维修等服务类合同的审查',
            contract_type: 'service',
            system_prompt: `你是一位专注于服务类合同的专业审查律师。请对用户提供的服务合同（如咨询服务合同、外包服务合同、维修服务合同等）进行专业审查。

审查重点：
1. 服务内容：服务范围、服务标准是否明确具体
2. 验收条件：验收标准、验收程序、验收期限
3. 服务期限：服务起止时间、续约条件
4. 付款条款：付款方式、付款条件、发票开具
5. 保密条款：保密范围、保密期限、违约责任
6. 知识产权：服务成果的知识产权归属
7. 违约责任：服务质量不达标的违约责任

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["服务内容明确性","验收条件","付款条款","保密条款","知识产权归属"]',
            is_active: 1,
            sort_order: 4
        },
        {
            name: '知识产权与技术合同审查',
            icon: '💡',
            description: '专注于技术转让、许可、技术开发等知识产权类合同的审查',
            contract_type: 'ip',
            system_prompt: `你是一位专注于知识产权与技术类合同的专业审查律师。请对用户提供的知识产权合同（如技术转让合同、技术许可合同、技术开发合同等）进行专业审查。

审查重点：
1. 权属归属：技术成果的知识产权归属是否明确
2. 许可范围：许可方式（独占/排他/普通）、许可地域、许可期限
3. 技术标准：技术指标、验收标准、验收方式
4. 侵权责任：技术侵权时的责任承担
5. 保密义务：技术秘密的保密范围和期限
6. 改进成果：后续改进技术的归属
7. 争议解决：技术争议的解决方式

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["权属归属","许可范围","技术标准","侵权责任","保密义务","改进成果归属"]',
            is_active: 1,
            sort_order: 5
        },
        {
            name: '劳动合同审查',
            icon: '👥',
            description: '专注于劳动合同、劳务合同、竞业限制等人身与劳动类合同的审查',
            contract_type: 'labor',
            system_prompt: `你是一位专注于劳动类合同的专业审查律师。请对用户提供的劳动类合同（如劳动合同、劳务合同、竞业限制协议等）进行专业审查。

审查重点：
1. 工资条款：工资构成、工资支付方式、加班费计算
2. 社保缴纳：社会保险和公积金的缴纳
3. 工作时间：标准工时、综合工时、不定时工时
4. 合同期限：固定期限、无固定期限、试用期约定
5. 解除条件：解除劳动合同的条件和程序
6. 竞业限制：竞业限制范围、期限、补偿金
7. 服务期约定：培训服务期、违约金

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["工资条款","社保缴纳","工作时间","合同期限","解除条件","竞业限制"]',
            is_active: 1,
            sort_order: 6
        },
        {
            name: '公司股权合同审查',
            icon: '📈',
            description: '专注于股权转让、增资扩股、股东协议等公司股权类合同的审查',
            contract_type: 'equity',
            system_prompt: `你是一位专注于公司股权类合同的专业审查律师。请对用户提供的股权类合同（如股权转让合同、增资扩股协议、股东协议等）进行专业审查。

审查重点：
1. 优先购买权：其他股东的优先购买权是否已放弃
2. 估值条款：股权估值方式、估值调整机制
3. 陈述保证：转让方的陈述与保证条款
4. 交割条件：股权交割的前提条件
5. 退出机制：股权转让限制、回购条款
6. 公司治理：股东会、董事会表决机制
7. 竞业禁止：原股东的竞业禁止义务

请按以下JSON格式返回：
{
  "summary": "合同整体评价",
  "risks": [{"level": "high/medium/low", "clause": "涉及条款", "reason": "风险原因", "suggestion": "修改建议"}],
  "key_terms": ["关键条款"],
  "overall_score": 75
}

请只返回JSON。`,
            knowledge_base_ids: '[]',
            review_focus: '["优先购买权","估值条款","陈述保证","交割条件","退出机制","公司治理"]',
            is_active: 1,
            sort_order: 7
        }
    ];

    for (const agent of defaultAgents) {
        db.run(
            `INSERT INTO agents (name, icon, description, contract_type, system_prompt, knowledge_base_ids, review_focus, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [agent.name, agent.icon, agent.description, agent.contract_type, agent.system_prompt, agent.knowledge_base_ids, agent.review_focus, agent.is_active, agent.sort_order]
        );
    }
    
    console.log('默认智能体初始化完成');
}

function ensureDbInitialized() {
    if (!db) {
        throw new Error('数据库未初始化！请先调用 initDatabase()');
    }
}

const dbProxy = {
    prepare: (sql) => {
        ensureDbInitialized();
        return {
            run: (...params) => {
                db.run(sql, params);
                saveDatabase();
                return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] || 0 };
            },
            get: (...params) => {
                const stmt = db.prepare(sql);
                stmt.bind(params);
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    stmt.free();
                    return row;
                }
                stmt.free();
                return undefined;
            },
            all: (...params) => {
                const results = [];
                const stmt = db.prepare(sql);
                stmt.bind(params);
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                return results;
            }
        };
    },
    exec: (sql) => {
        ensureDbInitialized();
        return db.exec(sql);
    },
    transaction: (fn) => {
        ensureDbInitialized();
        db.run("BEGIN TRANSACTION");
        try {
            fn();
            db.run("COMMIT");
            saveDatabase();
        } catch (e) {
            db.run("ROLLBACK");
            throw e;
        }
    }
};

module.exports = { initDatabase, db: dbProxy, saveDatabase };
