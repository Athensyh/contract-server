const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const { db, initDatabase } = require('./db');
const rag = require('./rag');

const app = express();
const PORT = process.env.PROXY_PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.ZHIPU_API_KEY;
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const SYSTEM_PROMPT = `你是一位专业的合同审查律师。请对用户提供的合同文本进行全面审查，并严格按以下JSON格式返回结果：

首先判断用户提供的内容是否为合同或合同相关文档。如果内容明显不是合同（如小说、新闻、代码、普通对话等），请返回：
{"error": "NOT_CONTRACT", "message": "抱歉，无法审查非合同相关的内容"}

如果内容是合同或合同相关文档，请按以下格式返回：
{
  "summary": "合同整体评价（一句话）",
  "risks": [
    {
      "level": "high/medium/low",
      "clause_number": "第X条 或 第X条第X款",
      "clause": "涉及条款的具体内容（从原文复制）",
      "reason": "风险原因",
      "suggestion": "修改建议"
    }
  ],
  "key_terms": ["关键条款1", "关键条款2"],
  "overall_score": 75
}

【clause_number字段要求 - 非常重要】：
1. 必须准确填写风险对应的条款编号
2. 格式示例："第1条"、"第一条"、"第3条第2款"、"第5章第2条"
3. 如果合同使用其他编号方式，按实际编号填写，如"一、"、"1."、"（一）"
4. 如果无法确定条款编号，填写"未知"

【clause字段要求】：
1. 从原文中复制涉及风险的具体内容
2. 如果无法确定具体内容，可以填写概括性描述

审查维度包括：违约责任是否对等、知识产权归属是否明确、保密条款是否完整、争议解决方式是否合理、付款条款是否明确、合同期限与解除条件是否清晰。

风险等级说明：
- high：高风险，可能导致重大经济损失或法律纠纷
- medium：中风险，需要关注但影响相对较小
- low：低风险，建议优化但不是必须

请只返回JSON，不要返回任何其他内容。`;

const SUMMARY_PROMPT = `你是一个合同分析助手。请从以下合同文本中提取最重要的关键条款，返回JSON格式：

返回格式要求（必须是合法的JSON，不要包含markdown代码块标记）：
{
  "key_clauses": [
    "第一条：合同双方...",
    "第二条：合同期限...",
    ...
  ]
}

请提取合同中的核心条款，包括但不限于：合同主体、合同期限、付款方式、违约责任、保密条款、争议解决等。每个条款用简洁的语言概括，保留关键信息。`;

async function callZhipuAPI(messages, maxTokens = 4096) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: 'glm-4-flash',
            messages: messages,
            max_tokens: maxTokens,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.error?.message || `API请求失败: ${response.status}`);
        error.status = response.status;
        error.code = errorData.error?.code;
        throw error;
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

function parseJSONResponse(content) {
    try {
        let jsonStr = content.trim();
        
        if (jsonStr.includes('```json')) {
            const match = jsonStr.match(/```json\s*([\s\S]*?)```/);
            if (match) {
                jsonStr = match[1].trim();
            }
        } else if (jsonStr.includes('```')) {
            const match = jsonStr.match(/```\s*([\s\S]*?)```/);
            if (match) {
                jsonStr = match[1].trim();
            }
        }
        
        if (jsonStr.startsWith('```json')) {
            jsonStr = jsonStr.slice(7);
        }
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.slice(3);
        }
        if (jsonStr.endsWith('```')) {
            jsonStr = jsonStr.slice(0, -3);
        }
        jsonStr = jsonStr.trim();
        
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }
        
        try {
            return { success: true, data: JSON.parse(jsonStr), raw: content };
        } catch (parseError) {
            console.log('首次JSON解析失败，尝试修复...');
            console.log('原始JSON片段:', jsonStr.substring(0, 200));
            
            let fixed = jsonStr
                .replace(/[""]/g, '"')
                .replace(/['']/g, "'")
                .replace(/,\s*}/g, '}')
                .replace(/,\s*]/g, ']')
                .replace(/\n/g, ' ')
                .replace(/\r/g, '')
                .replace(/\t/g, ' ')
                .replace(/\s+/g, ' ')
                .replace(/"\s*:\s*/g, '":')
                .replace(/:\s*"/g, ':"')
                .replace(/"\s*,\s*"/g, '","')
                .replace(/"\s*\]/g, '"]')
                .replace(/\[\s*"/g, '["')
                .replace(/\}\s*,\s*\{/g, '},{')
                .replace(/\]\s*,\s*\[/g, '],[');
            
            fixed = fixed
                .replace(/"level"\s*:\s*high/g, '"level":"high"')
                .replace(/"level"\s*:\s*medium/g, '"level":"medium"')
                .replace(/"level"\s*:\s*low/g, '"level":"low"')
                .replace(/"overall_score"\s*:\s*(\d+)/g, '"overall_score":$1');
            
            try {
                const result = JSON.parse(fixed);
                console.log('修复成功');
                return { success: true, data: result, raw: content };
            } catch (e) {
                console.log('修复后仍解析失败，尝试提取关键字段...');
                
                try {
                    const summaryMatch = fixed.match(/"summary"\s*:\s*"([^"]*)"/);
                    const scoreMatch = fixed.match(/"overall_score"\s*:\s*(\d+)/);
                    const keyTermsMatch = fixed.match(/"key_terms"\s*:\s*\[([^\]]*)\]/);
                    
                    let summary = summaryMatch ? summaryMatch[1] : '合同审查完成';
                    let score = scoreMatch ? parseInt(scoreMatch[1]) : 70;
                    let keyTerms = [];
                    
                    if (keyTermsMatch) {
                        const termsStr = keyTermsMatch[1];
                        const termMatches = termsStr.match(/"([^"]+)"/g);
                        if (termMatches) {
                            keyTerms = termMatches.map(t => t.replace(/"/g, ''));
                        }
                    }
                    
                    const risksMatch = fixed.match(/"risks"\s*:\s*\[/);
                    let risks = [];
                    
                    if (risksMatch) {
                        const riskBlocks = fixed.match(/\{[^{}]*"level"[^{}]*\}/g);
                        if (riskBlocks) {
                            risks = riskBlocks.map(block => {
                                const levelM = block.match(/"level"\s*:\s*"(\w+)"/);
                                
                                let clauseNumber = '';
                                const clauseNumberPatterns = [
                                    /"clause_number"\s*:\s*"((?:[^"\\]|\\.)*)"/,
                                    /"clause_number"\s*:\s*'([^']*)'/,
                                    /"clause_number"\s*:\s*([^,}\n]+)/
                                ];
                                for (const pattern of clauseNumberPatterns) {
                                    const match = block.match(pattern);
                                    if (match) {
                                        clauseNumber = match[1].replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\"/g, '"').trim();
                                        break;
                                    }
                                }
                                
                                let clause = '';
                                const clausePatterns = [
                                    /"clause"\s*:\s*"((?:[^"\\]|\\.)*)"/,
                                    /"clause"\s*:\s*'([^']*)'/,
                                    /"clause"\s*:\s*([^,}\n]+)/
                                ];
                                for (const pattern of clausePatterns) {
                                    const match = block.match(pattern);
                                    if (match) {
                                        clause = match[1].replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\"/g, '"').trim();
                                        break;
                                    }
                                }
                                
                                let reason = '';
                                const reasonPatterns = [
                                    /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/,
                                    /"reason"\s*:\s*'([^']*)'/,
                                    /"reason"\s*:\s*([^,}\n]+)/
                                ];
                                for (const pattern of reasonPatterns) {
                                    const match = block.match(pattern);
                                    if (match) {
                                        reason = match[1].replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\"/g, '"').trim();
                                        break;
                                    }
                                }
                                
                                let suggestion = '';
                                const suggestionPatterns = [
                                    /"suggestion"\s*:\s*"((?:[^"\\]|\\.)*)"/,
                                    /"suggestion"\s*:\s*'([^']*)'/,
                                    /"suggestion"\s*:\s*([^,}\n]+)/
                                ];
                                for (const pattern of suggestionPatterns) {
                                    const match = block.match(pattern);
                                    if (match) {
                                        suggestion = match[1].replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\"/g, '"').trim();
                                        break;
                                    }
                                }
                                
                                return {
                                    level: levelM ? levelM[1] : 'medium',
                                    clause_number: clauseNumber || '未知',
                                    clause: clause,
                                    reason: reason,
                                    suggestion: suggestion
                                };
                            }).filter(r => r.clause || r.reason);
                        }
                    }
                    
                    console.log('关键字段提取成功，风险数:', risks.length);
                    return {
                        success: true,
                        data: {
                            summary: summary,
                            overall_score: score,
                            key_terms: keyTerms,
                            risks: risks
                        },
                        raw: content
                    };
                } catch (extractError) {
                    console.log('关键字段提取失败，返回默认结构');
                    return {
                        success: false,
                        data: {
                            summary: 'AI返回的数据格式异常，请查看原始返回',
                            risks: [],
                            key_terms: [],
                            overall_score: 70
                        },
                        raw: content
                    };
                }
            }
        }
    } catch (e) {
        console.error('JSON解析失败:', e.message);
        return {
            success: false,
            data: {
                summary: 'AI返回的数据格式异常，请查看原始返回',
                risks: [],
                key_terms: [],
                overall_score: 70
            },
            raw: content
        };
    }
}

app.post('/api/review', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { text, forceFull = false } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的合同文本' 
            });
        }

        const MAX_LENGTH = 30000;
        let contractText = text;
        let isSimplified = false;

        if (text.length > MAX_LENGTH && !forceFull) {
            console.log(`合同过长 (${text.length} 字符)，正在提取关键条款...`);
            
            const summaryMessages = [
                { role: 'system', content: SUMMARY_PROMPT },
                { role: 'user', content: text }
            ];
            
            const summaryResult = await callZhipuAPI(summaryMessages, 2048);
            const summaryData = parseJSONResponse(summaryResult);
            
            contractText = '【关键条款摘要】\n\n' + summaryData.key_clauses.join('\n\n');
            isSimplified = true;
            
            console.log(`关键条款提取完成，共 ${summaryData.key_clauses.length} 条`);
        }

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: contractText }
        ];

        console.log(`开始审查合同 (${contractText.length} 字符)...`);
        const result = await callZhipuAPI(messages, 4096);
        const reviewData = parseJSONResponse(result);

        if (!reviewData.risks || !Array.isArray(reviewData.risks)) {
            reviewData.risks = [];
        }
        if (!reviewData.key_terms || !Array.isArray(reviewData.key_terms)) {
            reviewData.key_terms = [];
        }
        if (typeof reviewData.overall_score !== 'number') {
            reviewData.overall_score = 70;
        }
        if (!reviewData.summary) {
            reviewData.summary = '合同审查完成，请查看详细风险列表。';
        }

        reviewData.risks = reviewData.risks.map((risk, index) => ({
            id: index,
            type: risk.type || '其他风险',
            level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
            clause: risk.clause || '',
            clauseText: risk.clause || '',
            reason: risk.reason || '该条款存在潜在风险',
            suggestion: risk.suggestion || '建议咨询专业律师'
        }));

        reviewData.risks.sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.level] - order[b.level];
        });

        reviewData.is_simplified = isSimplified;

        console.log(`审查完成，发现 ${reviewData.risks.length} 个风险点`);
        res.json(reviewData);

    } catch (error) {
        console.error('审查错误:', error);

        if (error.status === 401 || error.code === 'invalid_api_key') {
            return res.status(401).json({ 
                error: 'INVALID_API_KEY',
                message: 'API密钥无效，请联系管理员' 
            });
        }

        if (error.status === 429 || error.code === 'rate_limit_exceeded') {
            return res.status(429).json({ 
                error: 'RATE_LIMIT',
                message: '请求过于频繁，请稍后再试' 
            });
        }

        if (error.status === 400 && error.message.includes('token')) {
            return res.status(400).json({ 
                error: 'TOKEN_LIMIT',
                message: '合同内容过长，请精简后重试' 
            });
        }

        res.status(500).json({ 
            error: 'REVIEW_FAILED',
            message: error.message || '审查服务暂时不可用，请稍后重试' 
        });
    }
});

app.post('/api/review/stream', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { text, forceFull = false } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的合同文本' 
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const MAX_LENGTH = 30000;
        let contractText = text;
        let isSimplified = false;

        if (text.length > MAX_LENGTH && !forceFull) {
            res.write(`data: ${JSON.stringify({ type: 'status', message: '正在提取关键条款...' })}\n\n`);
            
            const summaryMessages = [
                { role: 'system', content: SUMMARY_PROMPT },
                { role: 'user', content: text }
            ];
            
            const summaryResult = await callZhipuAPI(summaryMessages, 2048);
            const summaryData = parseJSONResponse(summaryResult);
            
            contractText = '【关键条款摘要】\n\n' + summaryData.key_clauses.join('\n\n');
            isSimplified = true;
        }

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: contractText }
        ];

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4-flash',
                messages: messages,
                max_tokens: 4096,
                temperature: 0.7,
                stream: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            res.write(`data: ${JSON.stringify({ type: 'error', message: errorData.error?.message || 'API请求失败' })}\n\n`);
            return res.end();
        }

        let fullContent = '';

        response.body.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    
                    if (data === '[DONE]') {
                        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                        return;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        
                        if (content) {
                            fullContent += content;
                            res.write(`data: ${JSON.stringify({ type: 'content', content: content })}\n\n`);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        });

        response.body.on('end', () => {
            const parseResult = parseJSONResponse(fullContent);
            
            if (parseResult.data.error === 'NOT_CONTRACT') {
                res.write(`data: ${JSON.stringify({ type: 'not_contract', message: parseResult.data.message || '抱歉，无法审查非合同相关的内容' })}\n\n`);
                res.end();
                return;
            }
            
            let reviewData = parseResult.data;
            
            if (!reviewData.risks || !Array.isArray(reviewData.risks)) {
                reviewData.risks = [];
            }
            if (!reviewData.key_terms || !Array.isArray(reviewData.key_terms)) {
                reviewData.key_terms = [];
            }
            if (typeof reviewData.overall_score !== 'number') {
                reviewData.overall_score = 70;
            }
            if (!reviewData.summary) {
                reviewData.summary = '合同审查完成，请查看详细风险列表。';
            }

            reviewData.risks = reviewData.risks.map((risk, index) => ({
                id: index,
                type: risk.type || '其他风险',
                level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
                clause: risk.clause || '',
                clauseText: risk.clause || '',
                reason: risk.reason || '该条款存在潜在风险',
                suggestion: risk.suggestion || '建议咨询专业律师'
            }));

            reviewData.risks.sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 };
                return order[a.level] - order[b.level];
            });

            reviewData.is_simplified = isSimplified;
            reviewData.parse_success = parseResult.success;
            reviewData.raw_response = parseResult.raw;

            res.write(`data: ${JSON.stringify({ type: 'complete', data: reviewData })}\n\n`);
            res.end();
        });

        response.body.on('error', (error) => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('流式审查错误:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || '审查服务暂时不可用' })}\n\n`);
        res.end();
    }
});

function smartSplitContract(text, maxSegmentLength = 15000) {
    const clausePattern = /(?=第[一二三四五六七八九十百千万零\d]+[条款章节])/g;
    const parts = text.split(clausePattern).filter(p => p.trim());
    
    if (parts.length === 0) {
        return [text];
    }
    
    const segments = [];
    let currentSegment = '';
    
    for (const part of parts) {
        if (currentSegment.length + part.length > maxSegmentLength && currentSegment.length > 0) {
            segments.push(currentSegment.trim());
            currentSegment = part;
        } else {
            currentSegment += part;
        }
    }
    
    if (currentSegment.trim()) {
        segments.push(currentSegment.trim());
    }
    
    return segments.length > 0 ? segments : [text];
}

function mergeReviewResults(results) {
    if (!results || results.length === 0) {
        return {
            summary: '审查完成',
            risks: [],
            key_terms: [],
            overall_score: 70
        };
    }
    
    if (results.length === 1) {
        return results[0];
    }
    
    const allRisks = results.flatMap(r => r.risks || []);
    const seenClauses = new Set();
    const uniqueRisks = [];
    
    for (const risk of allRisks) {
        const clauseKey = (risk.clause || risk.clauseText || '').substring(0, 50);
        if (!seenClauses.has(clauseKey)) {
            seenClauses.add(clauseKey);
            uniqueRisks.push(risk);
        }
    }
    
    uniqueRisks.sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.level] || 1) - (order[b.level] || 1);
    });
    
    uniqueRisks.forEach((risk, index) => {
        risk.id = index;
    });
    
    const allKeyTerms = [...new Set(results.flatMap(r => r.key_terms || []))];
    const avgScore = Math.round(
        results.reduce((sum, r) => sum + (r.overall_score || 70), 0) / results.length
    );
    
    const highCount = uniqueRisks.filter(r => r.level === 'high').length;
    const mediumCount = uniqueRisks.filter(r => r.level === 'medium').length;
    
    let summary = `分段审查完成，共发现 ${uniqueRisks.length} 个风险点`;
    if (highCount > 0) {
        summary += `，其中高风险 ${highCount} 个`;
    }
    if (mediumCount > 0) {
        summary += `，中风险 ${mediumCount} 个`;
    }
    
    return {
        summary,
        risks: uniqueRisks,
        key_terms: allKeyTerms,
        overall_score: avgScore,
        is_segmented: true,
        segment_count: results.length
    };
}

app.post('/api/review/segments', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { text, forceFull = false } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的合同文本' 
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const MAX_LENGTH = 30000;
        
        if (text.length <= MAX_LENGTH || forceFull) {
            res.write(`data: ${JSON.stringify({ type: 'status', message: '合同长度适中，直接审查...' })}\n\n`);
            
            const messages = [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: text }
            ];
            
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: messages,
                    max_tokens: 4096,
                    temperature: 0.7,
                    stream: true
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                res.write(`data: ${JSON.stringify({ type: 'error', message: errorData.error?.message || 'API请求失败' })}\n\n`);
                return res.end();
            }

            let fullContent = '';

            response.body.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        
                        if (data === '[DONE]') {
                            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                            return;
                        }
                        
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices?.[0]?.delta?.content || '';
                            
                            if (content) {
                                fullContent += content;
                                res.write(`data: ${JSON.stringify({ type: 'content', content: content })}\n\n`);
                            }
                        } catch (e) {
                        }
                    }
                }
            });

            response.body.on('end', () => {
                const parseResult = parseJSONResponse(fullContent);
                let reviewData = parseResult.data;
                
                if (!reviewData.risks) reviewData.risks = [];
                if (!reviewData.key_terms) reviewData.key_terms = [];
                if (typeof reviewData.overall_score !== 'number') reviewData.overall_score = 70;
                if (!reviewData.summary) reviewData.summary = '合同审查完成';

                reviewData.risks = reviewData.risks.map((risk, index) => ({
                    id: index,
                    type: risk.type || '其他风险',
                    level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
                    clause: risk.clause || '',
                    clauseText: risk.clause || '',
                    reason: risk.reason || '该条款存在潜在风险',
                    suggestion: risk.suggestion || '建议咨询专业律师'
                }));

                reviewData.risks.sort((a, b) => {
                    const order = { high: 0, medium: 1, low: 2 };
                    return order[a.level] - order[b.level];
                });

                res.write(`data: ${JSON.stringify({ type: 'complete', data: reviewData })}\n\n`);
                res.end();
            });

            response.body.on('error', (error) => {
                res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
                res.end();
            });

            return;
        }

        const segments = smartSplitContract(text);
        
        res.write(`data: ${JSON.stringify({ 
            type: 'status', 
            message: `合同较长，将分 ${segments.length} 段进行审查...` 
        })}\n\n`);

        const results = [];
        
        for (let i = 0; i < segments.length; i++) {
            res.write(`data: ${JSON.stringify({ 
                type: 'progress', 
                current: i + 1, 
                total: segments.length,
                message: `正在审查第 ${i + 1}/${segments.length} 段...`
            })}\n\n`);

            const messages = [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: segments[i] }
            ];

            try {
                const result = await callZhipuAPI(messages, 4096);
                const reviewData = parseJSONResponse(result);
                
                if (reviewData.data && !reviewData.data.error) {
                    results.push(reviewData.data);
                }
            } catch (e) {
                console.error(`第 ${i + 1} 段审查失败:`, e.message);
            }
        }

        const mergedResult = mergeReviewResults(results);
        
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'complete', data: mergedResult })}\n\n`);
        res.end();

    } catch (error) {
        console.error('分段审查错误:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || '审查服务暂时不可用' })}\n\n`);
        res.end();
    }
});

const CHAT_SYSTEM_PROMPT = `你是一位专业的法律助手，专门帮助用户解决合同相关问题。

回答格式要求：
1. 【法律分析】- 引用相关法律条文
2. 【实务建议】- 给出具体操作建议
3. 【风险提示】- 提醒注意事项
4. 【参考案例】（可选）- 相关判例

注意事项：
- 基于用户当前的合同审查结果回答
- 回答要具体、可操作
- 必须在回答末尾添加免责声明："⚠️ 以上内容仅供参考，不构成法律意见。建议咨询专业律师。"
- 如果用户询问具体条款，请结合上下文中的风险信息回答`;

app.post('/api/chat/stream', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { message, context, history } = req.body;

        if (!message || typeof message !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的问题' 
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let contextInfo = '';
        
        if (context && Object.keys(context).length > 0) {
            contextInfo = '\n\n当前上下文信息：';
            
            if (context.overallScore !== undefined) {
                contextInfo += `\n- 合同评分：${context.overallScore}分`;
            }
            
            if (context.risks && context.risks.length > 0) {
                contextInfo += `\n- 风险数量：${context.risks.length}个`;
                
                if (context.selectedRisk !== null && context.selectedRisk !== undefined) {
                    const risk = context.risks[context.selectedRisk];
                    if (risk) {
                        contextInfo += `\n- 当前选中风险：`;
                        contextInfo += `\n  • 等级：${risk.level}`;
                        contextInfo += `\n  • 类型：${risk.type || '其他风险'}`;
                        contextInfo += `\n  • 条款：${risk.clause || risk.clauseText || ''}`;
                        contextInfo += `\n  • 原因：${risk.reason || ''}`;
                        if (risk.suggestion) {
                            contextInfo += `\n  • 建议：${risk.suggestion}`;
                        }
                    }
                }
            }
        }

        const messages = [
            { 
                role: 'system', 
                content: CHAT_SYSTEM_PROMPT + contextInfo
            }
        ];

        if (history && Array.isArray(history) && history.length > 0) {
            history.forEach(msg => {
                messages.push({
                    role: msg.role,
                    content: msg.content
                });
            });
        }

        messages.push({ role: 'user', content: message });

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4-flash',
                messages: messages,
                max_tokens: 2048,
                temperature: 0.7,
                stream: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            res.write(`data: ${JSON.stringify({ type: 'error', message: errorData.error?.message || 'API请求失败' })}\n\n`);
            return res.end();
        }

        response.body.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    
                    if (data === '[DONE]') {
                        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                        return;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        
                        if (content) {
                            res.write(`data: ${JSON.stringify({ type: 'content', content: content })}\n\n`);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        });

        response.body.on('end', () => {
            res.end();
        });

        response.body.on('error', (error) => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('对话错误:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || '对话服务暂时不可用' })}\n\n`);
        res.end();
    }
});

app.get('/api/agents', (req, res) => {
    try {
        const agents = db.prepare('SELECT id, name, icon, description, contract_type, review_focus, is_active FROM agents WHERE is_active = 1 ORDER BY sort_order').all();
        res.json(agents);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.get('/api/agents/:id', (req, res) => {
    try {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND is_active = 1').get(req.params.id);
        if (!agent) {
            return res.status(404).json({ error: 'NOT_FOUND', message: '智能体不存在' });
        }
        res.json(agent);
    } catch (error) {
        res.status(500).json({ error: 'DATABASE_ERROR', message: error.message });
    }
});

app.post('/api/classify-contract', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'INVALID_INPUT', message: '请提供合同文本' });
        }
        
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
                messages: [{ role: 'user', content: classifyPrompt }],
                max_tokens: 100,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'API_ERROR', message: '分类请求失败' });
        }

        const data = await response.json();
        const contractType = data.choices[0].message.content.trim().toLowerCase();
        
        const agent = db.prepare('SELECT id, name, icon, contract_type FROM agents WHERE contract_type = ? AND is_active = 1').get(contractType);
        
        res.json({ 
            success: true, 
            contractType,
            recommendedAgent: agent || null
        });
    } catch (error) {
        res.status(500).json({ error: 'CLASSIFY_ERROR', message: error.message });
    }
});

app.post('/api/review/agent', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { text, agentId, forceFull = false } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的合同文本' 
            });
        }

        let agent = null;
        let systemPrompt = SYSTEM_PROMPT;
        let ragContext = null;

        if (agentId) {
            agent = db.prepare('SELECT * FROM agents WHERE id = ? AND is_active = 1').get(agentId);
            if (agent && agent.system_prompt) {
                systemPrompt = agent.system_prompt;
            }
        }

        const MAX_LENGTH = 30000;
        let contractText = text;
        let isSimplified = false;

        if (text.length > MAX_LENGTH && !forceFull) {
            console.log(`合同过长 (${text.length} 字符)，正在提取关键条款...`);
            
            const summaryMessages = [
                { role: 'system', content: SUMMARY_PROMPT },
                { role: 'user', content: text }
            ];
            
            const summaryResult = await callZhipuAPI(summaryMessages, 2048);
            const summaryData = parseJSONResponse(summaryResult);
            
            contractText = '【关键条款摘要】\n\n' + summaryData.key_clauses.join('\n\n');
            isSimplified = true;
            
            console.log(`关键条款提取完成，共 ${summaryData.key_clauses.length} 条`);
        }

        if (agent) {
            try {
                ragContext = await rag.getRAGContext(agent.id, contractText, 3);
                if (ragContext) {
                    systemPrompt = systemPrompt + '\n\n【参考知识库内容】\n' + ragContext;
                }
            } catch (e) {
                console.error('RAG检索失败:', e);
            }
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: contractText }
        ];

        console.log(`开始审查合同 (${contractText.length} 字符)，智能体: ${agent ? agent.name : '默认'}...`);
        const result = await callZhipuAPI(messages, 4096);
        const parsedResult = parseJSONResponse(result);
        
        let reviewData = parsedResult.data || parsedResult;

        if (reviewData.error === 'NOT_CONTRACT') {
            return res.json({
                error: 'NOT_CONTRACT',
                message: reviewData.message || '抱歉，无法审查非合同相关的内容',
                risks: [],
                key_terms: [],
                overall_score: 70,
                summary: '',
                is_simplified: false,
                agent_name: agent ? agent.name : null
            });
        }

        if (!reviewData.risks || !Array.isArray(reviewData.risks)) {
            reviewData.risks = [];
        }
        if (!reviewData.key_terms || !Array.isArray(reviewData.key_terms)) {
            reviewData.key_terms = [];
        }
        if (typeof reviewData.overall_score !== 'number') {
            reviewData.overall_score = 70;
        }
        if (!reviewData.summary) {
            reviewData.summary = '合同审查完成，请查看详细风险列表。';
        }

        reviewData.risks = reviewData.risks.map((risk, index) => ({
            id: index,
            type: risk.type || '其他风险',
            level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
            clause: risk.clause || '',
            clauseText: risk.clause || '',
            reason: risk.reason || '该条款存在潜在风险',
            suggestion: risk.suggestion || '建议咨询专业律师'
        }));

        reviewData.risks.sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.level] - order[b.level];
        });

        reviewData.is_simplified = isSimplified;
        reviewData.agent_name = agent ? agent.name : null;

        console.log(`审查完成，发现 ${reviewData.risks.length} 个风险点`);
        res.json(reviewData);

    } catch (error) {
        console.error('审查错误:', error);

        if (error.status === 401 || error.code === 'invalid_api_key') {
            return res.status(401).json({ 
                error: 'INVALID_API_KEY',
                message: 'API密钥无效，请联系管理员' 
            });
        }

        if (error.status === 429 || error.code === 'rate_limit_exceeded') {
            return res.status(429).json({ 
                error: 'RATE_LIMIT',
                message: '请求过于频繁，请稍后再试' 
            });
        }

        res.status(500).json({ 
            error: 'REVIEW_FAILED',
            message: error.message || '审查服务暂时不可用，请稍后重试' 
        });
    }
});

app.post('/api/review/agent/stream', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ 
                error: 'API_KEY_NOT_CONFIGURED',
                message: '服务端API密钥未配置' 
            });
        }

        const { text, agentId, forceFull = false } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                error: 'INVALID_INPUT',
                message: '请提供有效的合同文本' 
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        let agent = null;
        let systemPrompt = SYSTEM_PROMPT;

        if (agentId) {
            agent = db.prepare('SELECT * FROM agents WHERE id = ? AND is_active = 1').get(agentId);
            if (agent && agent.system_prompt) {
                systemPrompt = agent.system_prompt;
            }
        }

        const MAX_LENGTH = 30000;
        let contractText = text;
        let isSimplified = false;

        if (text.length > MAX_LENGTH && !forceFull) {
            res.write(`data: ${JSON.stringify({ type: 'status', message: '正在提取关键条款...' })}\n\n`);
            
            const summaryMessages = [
                { role: 'system', content: SUMMARY_PROMPT },
                { role: 'user', content: text }
            ];
            
            const summaryResult = await callZhipuAPI(summaryMessages, 2048);
            const summaryData = parseJSONResponse(summaryResult);
            
            contractText = '【关键条款摘要】\n\n' + summaryData.data.key_clauses.join('\n\n');
            isSimplified = true;
        }

        if (agent) {
            try {
                const ragContext = await rag.getRAGContext(agent.id, contractText, 3);
                if (ragContext) {
                    systemPrompt = systemPrompt + '\n\n【参考知识库内容】\n' + ragContext;
                }
            } catch (e) {
                console.error('RAG检索失败:', e);
            }
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: contractText }
        ];

        res.write(`data: ${JSON.stringify({ type: 'status', message: `正在使用${agent ? agent.name : '默认'}智能体审查...` })}\n\n`);

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: 'glm-4-flash',
                messages: messages,
                max_tokens: 4096,
                temperature: 0.7,
                stream: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            res.write(`data: ${JSON.stringify({ type: 'error', message: errorData.error?.message || 'API请求失败' })}\n\n`);
            return res.end();
        }

        let fullContent = '';

        response.body.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    
                    if (data === '[DONE]') {
                        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                        return;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        
                        if (content) {
                            fullContent += content;
                            res.write(`data: ${JSON.stringify({ type: 'content', content: fullContent })}\n\n`);
                        }
                    } catch (e) {
                    }
                }
            }
        });

        response.body.on('end', () => {
            const parseResult = parseJSONResponse(fullContent);
            
            if (parseResult.data && parseResult.data.error === 'NOT_CONTRACT') {
                res.write(`data: ${JSON.stringify({ type: 'not_contract', message: parseResult.data.message || '抱歉，无法审查非合同相关的内容' })}\n\n`);
                res.end();
                return;
            }
            
            let reviewData = parseResult.data || parseResult;
            
            if (!reviewData.risks || !Array.isArray(reviewData.risks)) {
                reviewData.risks = [];
            }
            if (!reviewData.key_terms || !Array.isArray(reviewData.key_terms)) {
                reviewData.key_terms = [];
            }
            if (typeof reviewData.overall_score !== 'number') {
                reviewData.overall_score = 70;
            }
            if (!reviewData.summary) {
                reviewData.summary = '合同审查完成，请查看详细风险列表。';
            }

            reviewData.risks = reviewData.risks.map((risk, index) => ({
                id: index,
                type: risk.type || '其他风险',
                level: ['high', 'medium', 'low'].includes(risk.level) ? risk.level : 'medium',
                clause: risk.clause || '',
                clauseText: risk.clause || '',
                reason: risk.reason || '该条款存在潜在风险',
                suggestion: risk.suggestion || '建议咨询专业律师'
            }));

            reviewData.risks.sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 };
                return order[a.level] - order[b.level];
            });

            reviewData.is_simplified = isSimplified;
            reviewData.agent_name = agent ? agent.name : null;

            res.write(`data: ${JSON.stringify({ type: 'complete', data: reviewData })}\n\n`);
            res.end();
        });

        response.body.on('error', (error) => {
            res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('流式审查错误:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || '审查服务暂时不可用' })}\n\n`);
        res.end();
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        apiKeyConfigured: !!API_KEY 
    });
});

app.use(express.static(path.join(__dirname, '..')));

async function startServer() {
    try {
        await initDatabase();
        console.log('数据库初始化完成');
        
        app.listen(PORT, () => {
            console.log(`代理服务已启动: http://localhost:${PORT}`);
            console.log(`API Key 状态: ${API_KEY ? '已配置' : '未配置'}`);
        });
    } catch (error) {
        console.error('服务器启动失败:', error);
        process.exit(1);
    }
}

startServer();
