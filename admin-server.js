const express = require('express');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
require('dotenv').config();

const { db, initDatabase } = require('./db');
const rag = require('./rag');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('错误: 请在 .env 文件中设置 ADMIN_PASSWORD');
    process.exit(1);
}

app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

if (!process.env.SESSION_SECRET) {
    console.error('错误: 请在 .env 文件中设置 SESSION_SECRET');
    process.exit(1);
}

const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const kbDir = path.join(uploadDir, `kb_${req.params.kbId}`);
        if (!fs.existsSync(kbDir)) {
            fs.mkdirSync(kbDir, { recursive: true });
        }
        cb(null, kbDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.txt', '.pdf', '.docx'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的文件格式'));
        }
    }
});

const requireAuth = (req, res, next) => {
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.status(401).json({ error: '未登录', message: '请先登录' });
    }
};

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    
    if (password === ADMIN_PASSWORD) {
        req.session.isLoggedIn = true;
        res.json({ success: true, message: '登录成功' });
    } else {
        res.status(401).json({ error: 'INVALID_PASSWORD', message: '密码错误' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: '已退出登录' });
});

app.get('/api/admin/check-auth', (req, res) => {
    res.json({ isLoggedIn: !!req.session.isLoggedIn });
});

app.get('/api/admin/agents', requireAuth, (req, res) => {
    try {
        const agents = db.prepare('SELECT * FROM agents ORDER BY sort_order').all();
        res.json(agents);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/admin/agents/:id', requireAuth, (req, res) => {
    try {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
        if (!agent) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '智能体不存在' });
        }
        res.json(agent);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/agents', requireAuth, (req, res) => {
    try {
        const { name, icon, description, contract_type, system_prompt, knowledge_base_ids, review_focus, is_active, sort_order } = req.body;
        
        const result = db.prepare(`
            INSERT INTO agents (name, icon, description, contract_type, system_prompt, knowledge_base_ids, review_focus, is_active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(name, icon || '⚖️', description, contract_type || 'general', system_prompt, JSON.stringify(knowledge_base_ids || []), JSON.stringify(review_focus || []), is_active ? 1 : 0, sort_order || 0);
        
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.put('/api/admin/agents/:id', requireAuth, (req, res) => {
    try {
        const { name, icon, description, contract_type, system_prompt, knowledge_base_ids, review_focus, is_active, sort_order } = req.body;
        
        db.prepare(`
            UPDATE agents 
            SET name = ?, icon = ?, description = ?, contract_type = ?, system_prompt = ?, 
                knowledge_base_ids = ?, review_focus = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(name, icon, description, contract_type, system_prompt, JSON.stringify(knowledge_base_ids || []), JSON.stringify(review_focus || []), is_active ? 1 : 0, sort_order || 0, req.params.id);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.delete('/api/admin/agents/:id', requireAuth, (req, res) => {
    try {
        db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/agents/:id/prompt-versions', requireAuth, (req, res) => {
    try {
        const { prompt_content, version_note } = req.body;
        
        db.prepare(`
            INSERT INTO prompt_versions (agent_id, prompt_content, version_note)
            VALUES (?, ?, ?)
        `).run(req.params.id, prompt_content, version_note);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/admin/agents/:id/prompt-versions', requireAuth, (req, res) => {
    try {
        const versions = db.prepare(`
            SELECT * FROM prompt_versions 
            WHERE agent_id = ? 
            ORDER BY created_at DESC 
            LIMIT 10
        `).all(req.params.id);
        res.json(versions);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/agents/:id/restore-prompt/:versionId', requireAuth, (req, res) => {
    try {
        const version = db.prepare('SELECT prompt_content FROM prompt_versions WHERE id = ? AND agent_id = ?').get(req.params.versionId, req.params.id);
        
        if (!version) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '版本不存在' });
        }
        
        db.prepare('UPDATE agents SET system_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(version.prompt_content, req.params.id);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/admin/knowledge-bases', requireAuth, (req, res) => {
    try {
        const kbs = db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all();
        res.json(kbs);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/admin/knowledge-bases/:id', requireAuth, (req, res) => {
    try {
        const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(req.params.id);
        if (!kb) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '知识库不存在' });
        }
        res.json(kb);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/knowledge-bases', requireAuth, (req, res) => {
    try {
        const { name, description, contract_type } = req.body;
        
        const result = db.prepare(`
            INSERT INTO knowledge_bases (name, description, contract_type)
            VALUES (?, ?, ?)
        `).run(name, description, contract_type);
        
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.put('/api/admin/knowledge-bases/:id', requireAuth, (req, res) => {
    try {
        const { name, description, contract_type } = req.body;
        
        db.prepare(`
            UPDATE knowledge_bases 
            SET name = ?, description = ?, contract_type = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(name, description, contract_type, req.params.id);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.delete('/api/admin/knowledge-bases/:id', requireAuth, (req, res) => {
    try {
        const documents = db.prepare('SELECT id FROM documents WHERE knowledge_base_id = ?').all(req.params.id);
        
        for (const doc of documents) {
            db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(doc.id);
        }
        
        db.prepare('DELETE FROM documents WHERE knowledge_base_id = ?').run(req.params.id);
        db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(req.params.id);
        
        const indexPath = path.join(__dirname, '..', 'data', 'vectors', `kb_${req.params.id}.index`);
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/admin/knowledge-bases/:kbId/documents', requireAuth, (req, res) => {
    try {
        const docs = db.prepare('SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY created_at DESC').all(req.params.kbId);
        res.json(docs);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/knowledge-bases/:kbId/documents', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'NO_FILE', message: '请上传文件' });
        }

        const result = db.prepare(`
            INSERT INTO documents (knowledge_base_id, file_name, file_path, file_size, status)
            VALUES (?, ?, ?, ?, 'pending')
        `).run(req.params.kbId, req.file.originalname, req.file.path, req.file.size);

        const documentId = result.lastInsertRowid;

        if (documentId && documentId > 0) {
            processDocumentAsync(documentId).catch(err => {
                console.error(`文档 ${documentId} 异步处理失败:`, err);
            });
        }

        res.json({ success: true, id: documentId, message: '文件上传成功，正在处理中' });
    } catch (error) {
        res.status(500).json({ error: 'UPLOAD_ERROR', message: error.message });
    }
});

async function processDocumentAsync(documentId) {
    try {
        if (!documentId || documentId <= 0) {
            console.error(`无效的文档ID: ${documentId}`);
            return;
        }
        
        console.log(`开始处理文档 ${documentId}...`);
        const result = await rag.processDocument(documentId);
        console.log(`文档 ${documentId} 处理完成:`, result);
        return result;
    } catch (error) {
        console.error(`文档 ${documentId} 处理失败:`, error);
        
        try {
            db.prepare('UPDATE documents SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', error.message, documentId);
        } catch (dbError) {
            console.error(`更新文档错误状态失败:`, dbError);
        }
    }
}

app.post('/api/admin/documents/:id/process', requireAuth, async (req, res) => {
    try {
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
        if (!doc) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在' });
        }
        
        if (doc.status === 'processing') {
            return res.status(400).json({ error: 'ALREADY_PROCESSING', message: '文档正在处理中' });
        }
        
        db.prepare('UPDATE documents SET status = ?, error_message = NULL WHERE id = ?').run('pending', req.params.id);
        
        processDocumentAsync(req.params.id)
            .then(() => {
                console.log(`文档 ${req.params.id} 处理成功`);
            })
            .catch(err => {
                console.error(`文档 ${req.params.id} 处理失败:`, err);
            });
        
        res.json({ success: true, message: '文档处理已启动' });
    } catch (error) {
        res.status(500).json({ error: 'PROCESS_ERROR', message: error.message });
    }
});

app.get('/api/admin/documents/:id', requireAuth, (req, res) => {
    try {
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
        if (!doc) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在' });
        }
        res.json(doc);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.delete('/api/admin/documents/:id', requireAuth, (req, res) => {
    try {
        const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
        
        if (doc) {
            if (doc.file_path && fs.existsSync(doc.file_path)) {
                fs.unlinkSync(doc.file_path);
            }
            
            db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(req.params.id);
            db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
            
            rag.rebuildKnowledgeBaseIndex(doc.knowledge_base_id).catch(console.error);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/knowledge-bases/:kbId/rebuild', requireAuth, async (req, res) => {
    try {
        const result = await rag.rebuildKnowledgeBaseIndex(req.params.kbId);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: 'REBUILD_ERROR', message: error.message });
    }
});

app.post('/api/admin/knowledge-bases/:kbId/search', requireAuth, async (req, res) => {
    try {
        const { query, topK } = req.body;
        const results = await rag.searchKnowledgeBase(req.params.kbId, query, topK || 5);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'SEARCH_ERROR', message: error.message });
    }
});

app.get('/api/admin/documents/:id/chunks', requireAuth, (req, res) => {
    try {
        const chunks = db.prepare('SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index').all(req.params.id);
        res.json(chunks);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/admin/test-prompt', requireAuth, async (req, res) => {
    try {
        const { prompt, testText } = req.body;
        
        const API_KEY = process.env.ZHIPU_API_KEY;
        const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
        
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4-flash',
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: testText }
                ],
                max_tokens: 4096,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            return res.status(response.status).json({ error: 'API_ERROR', message: error.error?.message || 'API请求失败' });
        }

        const data = await response.json();
        res.json({ success: true, result: data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: 'TEST_ERROR', message: error.message });
    }
});

app.post('/api/admin/classify-contract', requireAuth, async (req, res) => {
    try {
        const { text } = req.body;
        
        const API_KEY = process.env.ZHIPU_API_KEY;
        const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
        
        const classifyPrompt = `请判断以下合同文本属于哪种类型，只返回类型代码，不要返回其他内容。

类型代码：
- general: 通用合同
- property: 物权类合同（房产买卖、土地转让、抵押等）
- financial: 金融类合同（借款、担保、融资租赁等）
- construction: 建设工程类合同（工程承包、设计、监理等）
- service: 服务类合同（咨询、外包、维修等）
- ip: 知识产权与技术类合同（技术转让、许可、开发等）
- labor: 人身与劳动类合同（劳动合同、劳务合同、竞业协议等）
- equity: 公司股权类合同（股权转让、增资扩股、股东协议等）

合同文本：
${text.slice(0, 2000)}`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4-flash',
                messages: [
                    { role: 'user', content: classifyPrompt }
                ],
                max_tokens: 100,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'API_ERROR', message: '分类请求失败' });
        }

        const data = await response.json();
        const contractType = data.choices[0].message.content.trim().toLowerCase();
        
        const agent = db.prepare('SELECT * FROM agents WHERE contract_type = ? AND is_active = 1').get(contractType);
        
        res.json({ 
            success: true, 
            contractType,
            recommendedAgent: agent || null
        });
    } catch (error) {
        res.status(500).json({ error: 'CLASSIFY_ERROR', message: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

app.use(express.static(path.join(__dirname, '..'), { index: false }));

app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

async function startServer() {
    try {
        await initDatabase();
        console.log('数据库初始化完成');
        
        app.listen(PORT, () => {
            console.log(`后台管理系统已启动: http://localhost:${PORT}`);
            console.log(`默认密码: ${ADMIN_PASSWORD}`);
        });
    } catch (error) {
        console.error('服务器启动失败:', error);
        process.exit(1);
    }
}

startServer();
