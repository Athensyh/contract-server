const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { db } = require('./db');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');

const VECTORS_DIR = path.join(__dirname, '..', 'data', 'vectors');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

const vectorStores = new Map();

function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class SimpleVectorStore {
    constructor(id) {
        this.id = id;
        this.vectors = [];
        this.metadata = [];
        this.filePath = path.join(VECTORS_DIR, `${id}.json`);
        this.load();
    }

    load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.vectors = data.vectors || [];
                this.metadata = data.metadata || [];
            } catch (e) {
                this.vectors = [];
                this.metadata = [];
            }
        }
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify({
            vectors: this.vectors,
            metadata: this.metadata
        }));
    }

    addVector(vector, meta) {
        this.vectors.push(vector);
        this.metadata.push(meta);
        this.save();
    }

    search(queryVector, topK = 5) {
        if (this.vectors.length === 0) return [];
        
        const similarities = this.vectors.map((v, i) => ({
            index: i,
            similarity: cosineSimilarity(queryVector, v),
            metadata: this.metadata[i]
        }));
        
        similarities.sort((a, b) => b.similarity - a.similarity);
        return similarities.slice(0, topK);
    }

    clear() {
        this.vectors = [];
        this.metadata = [];
        this.save();
    }
}

function getVectorStore(knowledgeBaseId) {
    if (!vectorStores.has(knowledgeBaseId)) {
        vectorStores.set(knowledgeBaseId, new SimpleVectorStore(knowledgeBaseId));
    }
    return vectorStores.get(knowledgeBaseId);
}

async function getEmbedding(text) {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
        throw new Error('API密钥未配置');
    }

    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/embeddings', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'embedding-2',
            input: text
        })
    });

    if (!response.ok) {
        throw new Error('获取向量嵌入失败');
    }

    const data = await response.json();
    return data.data[0].embedding;
}

function splitTextIntoChunks(text, chunkSize = 500, overlap = 50) {
    const chunks = [];
    let start = 0;
    
    while (start < text.length) {
        let end = start + chunkSize;
        
        if (end < text.length) {
            const lastPeriod = text.lastIndexOf('。', end);
            const lastNewline = text.lastIndexOf('\n', end);
            const breakPoint = Math.max(lastPeriod, lastNewline);
            if (breakPoint > start + chunkSize / 2) {
                end = breakPoint + 1;
            }
        }
        
        chunks.push(text.slice(start, end).trim());
        start = end - overlap;
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

function detectAndDecodeText(buffer) {
    const detected = jschardet.detect(buffer);
    let encoding = detected.encoding || 'utf-8';
    
    const encodingMap = {
        'GB2312': 'gbk',
        'GB18030': 'gbk',
        'GBK': 'gbk',
        'UTF-8': 'utf8',
        'UTF8': 'utf8',
        'ASCII': 'utf8',
        'ISO-8859-1': 'latin1',
        'BIG5': 'big5'
    };
    
    encoding = encodingMap[encoding.toUpperCase()] || encoding.toLowerCase();
    
    if (iconv.encodingExists(encoding)) {
        try {
            const decoded = iconv.decode(buffer, encoding);
            if (decoded && !decoded.includes('�')) {
                return decoded;
            }
        } catch (e) {
        }
    }
    
    try {
        const utf8Text = buffer.toString('utf8');
        if (!utf8Text.includes('�')) {
            return utf8Text;
        }
    } catch (e) {
    }
    
    try {
        const gbkText = iconv.decode(buffer, 'gbk');
        if (gbkText && !gbkText.includes('�')) {
            return gbkText;
        }
    } catch (e) {
    }
    
    return buffer.toString('utf8');
}

async function processDocument(documentId) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
    if (!doc) {
        throw new Error('文档不存在');
    }

    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run('processing', documentId);

    try {
        let text = '';
        const filePath = doc.file_path;

        if (filePath.endsWith('.txt')) {
            const buffer = fs.readFileSync(filePath);
            text = detectAndDecodeText(buffer);
        } else if (filePath.endsWith('.pdf')) {
            const pdfParse = require('pdf-parse');
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            text = pdfData.text;
        } else if (filePath.endsWith('.docx')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
        } else {
            throw new Error('不支持的文件格式');
        }

        if (!text || text.trim().length === 0) {
            throw new Error('文档内容为空');
        }

        const chunks = splitTextIntoChunks(text);
        const store = getVectorStore(doc.knowledge_base_id);

        for (let i = 0; i < chunks.length; i++) {
            const embedding = await getEmbedding(chunks[i]);
            store.addVector(embedding, {
                documentId: documentId,
                chunkIndex: i,
                text: chunks[i]
            });

            db.prepare('INSERT INTO document_chunks (document_id, chunk_text, chunk_index, embedding_status) VALUES (?, ?, ?, ?)').run(
                documentId, chunks[i], i, 'completed'
            );
        }

        db.prepare('UPDATE documents SET status = ?, chunk_count = ? WHERE id = ?').run('completed', chunks.length, documentId);
        
        const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(doc.knowledge_base_id);
        if (kb) {
            const newChunkCount = (kb.chunk_count || 0) + chunks.length;
            const newDocCount = (kb.document_count || 0) + 1;
            db.prepare('UPDATE knowledge_bases SET chunk_count = ?, document_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
                newChunkCount, newDocCount, doc.knowledge_base_id
            );
        }

        return { success: true, chunkCount: chunks.length };
    } catch (error) {
        db.prepare('UPDATE documents SET status = ?, error_message = ? WHERE id = ?').run('failed', error.message, documentId);
        throw error;
    }
}

async function searchKnowledgeBase(knowledgeBaseId, query, topK = 5) {
    const store = getVectorStore(knowledgeBaseId);
    
    if (store.vectors.length === 0) {
        return [];
    }

    const queryEmbedding = await getEmbedding(query);
    const results = store.search(queryEmbedding, topK);

    return results.map(r => ({
        text: r.metadata.text,
        similarity: r.similarity,
        documentId: r.metadata.documentId
    }));
}

async function searchMultipleKnowledgeBases(knowledgeBaseIds, query, topK = 5) {
    const allResults = [];

    for (const kbId of knowledgeBaseIds) {
        try {
            const results = await searchKnowledgeBase(kbId, query, topK);
            allResults.push(...results);
        } catch (e) {
            console.error(`搜索知识库 ${kbId} 失败:`, e);
        }
    }

    allResults.sort((a, b) => b.similarity - a.similarity);
    return allResults.slice(0, topK);
}

function clearKnowledgeBaseVectors(knowledgeBaseId) {
    const store = getVectorStore(knowledgeBaseId);
    store.clear();
}

async function getRAGContext(agentId, query, topK = 3) {
    const agent = db.prepare('SELECT knowledge_base_ids FROM agents WHERE id = ?').get(agentId);
    if (!agent || !agent.knowledge_base_ids) {
        return null;
    }

    let kbIds = [];
    try {
        kbIds = JSON.parse(agent.knowledge_base_ids);
    } catch (e) {
        return null;
    }

    if (!Array.isArray(kbIds) || kbIds.length === 0) {
        return null;
    }

    const results = await searchMultipleKnowledgeBases(kbIds, query, topK);
    
    if (results.length === 0) {
        return null;
    }

    return results.map(r => r.text).join('\n\n---\n\n');
}

async function rebuildKnowledgeBaseIndex(knowledgeBaseId) {
    clearKnowledgeBaseVectors(knowledgeBaseId);
    
    const docs = db.prepare('SELECT id FROM documents WHERE knowledge_base_id = ? AND status = ?', [knowledgeBaseId, 'completed']).all();
    
    let totalChunks = 0;
    for (const doc of docs) {
        const chunks = db.prepare('SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index').all(doc.id);
        
        for (const chunk of chunks) {
            try {
                const embedding = await getEmbedding(chunk.chunk_text);
                const store = getVectorStore(knowledgeBaseId);
                store.addVector(embedding, {
                    documentId: doc.id,
                    chunkIndex: chunk.chunk_index,
                    text: chunk.chunk_text
                });
                totalChunks++;
            } catch (e) {
                console.error(`重建索引失败 - 文档 ${doc.id} 块 ${chunk.chunk_index}:`, e);
            }
        }
    }
    
    return { success: true, chunkCount: totalChunks };
}

module.exports = {
    processDocument,
    searchKnowledgeBase,
    searchMultipleKnowledgeBases,
    clearKnowledgeBaseVectors,
    getEmbedding,
    getVectorStore,
    getRAGContext,
    rebuildKnowledgeBaseIndex
};
