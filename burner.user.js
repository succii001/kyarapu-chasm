// ==UserScript==
// @name         Kyarapu Chasm burner
// @namespace    https://github.com/chasm-js
// @version      KYARA-BURN-v1.0.0-alpha
// @description  当方はJavaScript初心者です。専門家の方や、お詳しい方がいらっしゃいましたら、改善点などを指摘していただけると大変助かります。
// @author       chasm-js, milkyway0308, succii(Dr.MJ)
// @match        https://kyarapu.com/u/*
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.kyarapu.com
// @connect      generativelanguage.googleapis.com
// @connect      openrouter.ai
// @downloadURL  https://github.com/succii001/kyarapu-chasm/raw/refs/heads/main/burner.user.js
// @updateURL    https://github.com/succii001/kyarapu-chasm/raw/refs/heads/main/burner.user.js
// ==/UserScript==

!(async function () {
    "use strict";

    // --- 設定および定数 ---
    const kyarapuApiBase = "https://api.kyarapu.com";
    const buttonTargetClass = "css-yd8sa2";
    let timerInterval = null;
    let resultCounter = 0;

    // --- ユーティリティ関数 ---
    function c(n, e) { let t; return function (...o) { clearTimeout(t); t = setTimeout(() => n(...o), e); }; }
    function u() { const n = location.pathname.match(/\/u\/([a-f0-9]+)\/c\/([a-f0-9]+)/); return n ? { characterId: n[1], chatroomId: n[2] } : null; }
    function m(n) { const nameEQ = n + "="; const ca = document.cookie.split(';'); for (let i = 0; i < ca.length; i++) { let c = ca[i]; while (c.charAt(0) === ' ') c = c.substring(1, c.length); if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length)); } return null; }
    function g(n, e = "不明なエラー", t = null, o = null) { const a = [`コンテキスト: ${e}`, `エラーメッセージ: ${n.message || n}`, t ? `リクエスト: ${JSON.stringify(t, null, 2)}` : "", o ? `レスポンス: ${JSON.stringify(o, null, 2)}` : ""].filter(Boolean).join("\n"); prompt("致命的なエラーが発生しました。以下の内容をコピーしてお問い合わせください：", `[Kyarapu Chasm burner Error]\n${a}\n\nエラー内容をコピーして https://gall.dcinside.com/mini/chasm までお問い合わせください。`); throw n; }

    // --- API通信クラス ---
    class KyarapuAPI {
        async _request(method, url, body = null) {
            const headers = { Authorization: `Bearer ${m("access_token")}`, "Content-Type": "application/json" };
            const options = { method, headers };
            if (body) options.body = JSON.stringify(body);
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    const errorText = await response.text();
                    let errorJson;
                    try { errorJson = JSON.parse(errorText); } catch { /* no-op */ }
                    throw new Error(errorJson?.message || `HTTP ${response.status}: ${errorText}`);
                }
                return response.status === 204 ? { ok: true } : await response.json();
            } catch (error) {
                throw error;
            }
        }
        async getMessages(roomId, cursor = "", limit = 100) {
            const url = `${kyarapuApiBase}/kyarapu-chat/${roomId}/messages?limit=${limit}&platform=web${cursor ? '&cursor=' + cursor : ''}`;
            return await this._request("GET", url);
        }
    }

    // --- 設定管理 ---
    const f = {
        geminiAPIKey: "", openrouterAPIKey: "", apiProvider: "gemini", maxTokens: 8192,
        temperature: 0.5, geminiModel: "gemini-2.5-flash", openrouterModel: "google/gemini-pro-1.5",
        customGeminiModel: "",
        messageLimit: 40,
        prependText: "**OOC: これまでのロールプレイングの進行状況の要約です。今後の応答でこの要約内容を参照します。**",
        appendText: "", activePromptId: "p1"
    };

    class S {
        async loadSettings() {
            for (const key of Object.keys(f)) {
                f[key] = await GM_getValue(key, f[key]);
            }
        }
        async saveSettings() {
            for (const key of Object.keys(f)) {
                await GM_setValue(key, f[key]);
            }
        }
    }

    // --- メインロジック ---
    async function w(promptTemplate) {
        if (timerInterval) clearInterval(timerInterval);
        const startTime = Date.now();
        const executeBtn = document.querySelector("#execute-btn");
        const timerEl = document.querySelector("#chasm-burner-timer");

        executeBtn.disabled = true;

        timerInterval = setInterval(() => {
            const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
            const minutes = String(Math.floor(elapsedTime / 60)).padStart(2, '0');
            const seconds = String(elapsedTime % 60).padStart(2, '0');
            const formattedTime = `${minutes}:${seconds}`;
            if(timerEl) timerEl.textContent = formattedTime;
            if(executeBtn) executeBtn.textContent = `バーナー要約中... ${formattedTime}`;
        }, 1000);

        const cleanup = () => {
            clearInterval(timerInterval);
            timerInterval = null;
            if(executeBtn) {
                executeBtn.disabled = false;
                executeBtn.textContent = "要約開始";
            }
            if(timerEl) timerEl.textContent = "00:00";
        };

        const { chatroomId } = u() || {};
        if (!chatroomId) {
            alert("チャットルームIDがURLに見つかりません。");
            cleanup();
            return;
        }

        const logContainer = document.querySelector("#chasm-burner-log");
        const statusEl = document.querySelector("#chasm-burner-status");
        const log = (message, status = '進行中') => {
            if (logContainer) {
                const timestamp = new Date().toLocaleTimeString();
                logContainer.innerHTML += `<div>[${timestamp}] ${message}</div>`;
                logContainer.scrollTop = logContainer.scrollHeight;
            }
            if (statusEl) statusEl.textContent = status;
        };

        try {
            if (logContainer) logContainer.innerHTML = '';
            log("バーナープロセスを開始します。", "開始");

            const api = new KyarapuAPI();
            log(`最新メッセージ${f.messageLimit}件を読み込んでいます。`);

            let allMessages = [];
            const res = await api.getMessages(chatroomId, "", f.messageLimit);
            if (res?.data?.list) {
                allMessages = res.data.list
                    .filter(m => m.content)
                    .map(m => ({ role: m.role === 'assistant' ? "AI" : "User", content: m.content }))
                    .reverse();
                log(`計${allMessages.length}件のメッセージを正常に読み込みました。`);
            } else { throw new Error("メッセージリストを取得できませんでした。"); }

            if (allMessages.length === 0) {
                log("要約する会話がありません。", "完了");
                cleanup();
                return;
            }

            const chatHistoryText = allMessages.map(m => `${m.role}: ${m.content}`).join('\n');
            log("外部APIに要約リクエストを送信します。");

            const summaryPromise = new Promise((resolve, reject) => {
                let apiUrl, apiBody, apiHeaders = {};
                let modelToUse;
                if (f.apiProvider === 'gemini') {
                    modelToUse = document.querySelector("#burner-gemini-model-select").value;
                    if (modelToUse === "direct-input") {
                        modelToUse = document.querySelector("#burner-custom-gemini-model").value;
                    }
                } else {
                    modelToUse = f.openrouterModel;
                }

                let fullPrompt;
                if (promptTemplate.includes("{{chat_history}}")) {
                    fullPrompt = promptTemplate.replace("{{chat_history}}", chatHistoryText);
                } else {
                    fullPrompt = `${promptTemplate}\n\n<会話内容>\n${chatHistoryText}`;
                }

                if (f.apiProvider === 'gemini') {
                    if (!f.geminiAPIKey) return reject(new Error("Gemini APIキーが設定されていません。"));
                    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${f.geminiAPIKey}`;
                    apiBody = { contents: [{ role: "user", parts: [{ text: fullPrompt }] }], generationConfig: { temperature: f.temperature, maxOutputTokens: f.maxTokens } };
                } else {
                    if (!f.openrouterAPIKey) return reject(new Error("OpenRouter APIキーが設定されていません。"));
                    apiUrl = "https://openrouter.ai/api/v1/chat/completions";
                    apiBody = { model: modelToUse, messages: [{ role: "user", content: fullPrompt }], max_tokens: f.maxTokens, temperature: f.temperature };
                    apiHeaders = { Authorization: `Bearer ${f.openrouterAPIKey}` };
                }
                GM.xmlHttpRequest({
                    method: "POST", url: apiUrl, data: JSON.stringify(apiBody), headers: { "Content-Type": "application/json", ...apiHeaders },
                    onload: res => res.status >= 200 && res.status < 300 ? resolve(JSON.parse(res.responseText)) : reject(new Error(`API Error: ${res.status}, ${res.responseText}`)),
                    onerror: err => reject(err)
                });
            });

            const summaryRes = await summaryPromise;
            let summaryText;
            if (f.apiProvider === 'gemini') summaryText = summaryRes?.candidates?.[0]?.content?.parts?.[0]?.text;
            else summaryText = summaryRes?.choices?.[0]?.message?.content;

            if (summaryText) {
                log("要約を正常に受信しました。", "結果確認");
                displaySummaryResult(summaryText);
            } else { throw new Error("APIレスポンスから要約内容が見つかりません。"); }

        } catch (error) {
            log(`要約生成失敗： ${error.message}`, "エラー");
            alert(`要約生成失敗： ${error.message}`);
        } finally {
            cleanup();
        }
    }

    // --- UI関連関数 ---
    function attachTabListener(btn) {
        btn.addEventListener('click', e => {
            const tabId = e.target.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            const targetContent = document.querySelector(`#${tabId}`);
            if(targetContent) targetContent.style.display = 'block';
        });
    }

    function displaySummaryResult(summaryText) {
        resultCounter++;
        const currentResultId = resultCounter;

        const tabContainer = document.querySelector("#chasm-burner-modal .tab-container");
        const contentContainer = document.querySelector("#chasm-burner-modal .modal-content-wrapper");

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

        const newTabBtn = document.createElement('button');
        newTabBtn.className = 'tab-btn active';
        newTabBtn.dataset.tab = `result-${currentResultId}`;
        newTabBtn.textContent = `結果 ${currentResultId}`;
        tabContainer.appendChild(newTabBtn);
        attachTabListener(newTabBtn);

        const newTabContent = document.createElement('div');
        newTabContent.id = `result-${currentResultId}`;
        newTabContent.className = 'tab-content';
        newTabContent.style.display = 'block';
        newTabContent.innerHTML = `
            <div class="setting-item" style="position: relative;">
                <label for="summary-result-${currentResultId}">要約結果（修正可能）</label>
                <textarea id="summary-result-${currentResultId}" rows="15" style="width: 100%; background-color: #40444b; color: white; border: 1px solid #555; border-radius: 4px; padding: 10px; padding-bottom: 30px; box-sizing: border-box;"></textarea>
                <div id="char-count-${currentResultId}" style="position: absolute; bottom: 15px; right: 20px; font-size: 14px; color: #ccc; background-color: #40444b; padding: 2px 5px; border-radius: 3px;">文字数: 0</div>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button id="copy-summary-${currentResultId}" style="flex-grow: 1; padding: 10px; background-color: #4caf50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px;">クリップボードにコピー</button>
                <button id="split-copy-summary-${currentResultId}" style="flex-grow: 1; padding: 10px; background-color: #f39c12; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; display: none;">分割コピー (1/N)</button>
            </div>
        `;
        contentContainer.appendChild(newTabContent);

        const textarea = document.querySelector(`#summary-result-${currentResultId}`);
        const charCountEl = document.querySelector(`#char-count-${currentResultId}`);
        const copyButton = document.querySelector(`#copy-summary-${currentResultId}`);
        const splitCopyButton = document.querySelector(`#split-copy-summary-${currentResultId}`);
        textarea.value = summaryText;

        let chunks = [];
        let currentChunkIndex = 0;

        function createChunks(summary, prepend, append) {
            const MAX_LENGTH = 1999;
            const newChunks = [];
            let textCursor = 0;

            const estimatedHeader = `(10/10)番目の要約です。\n\n`;
            const prependOverhead = prepend ? prepend.length + 2 : 0;
            const contentSpacePerChunk = MAX_LENGTH - estimatedHeader.length - prependOverhead;
            const totalContentLength = summary.length + (append ? append.length + 2 : 0);
            const totalChunks = Math.ceil(totalContentLength / contentSpacePerChunk);

            for (let i = 0; i < totalChunks; i++) {
                const isLastChunk = (i === totalChunks - 1);
                const header = `(${i + 1}/${totalChunks})番目の要約です。\n\n`;

                let currentOverhead = header.length;
                if (prepend) currentOverhead += prepend.length + 2;
                if (isLastChunk && append) currentOverhead += append.length + 2;

                const availableForSummary = MAX_LENGTH - currentOverhead;
                const summarySlice = summary.substring(textCursor, textCursor + availableForSummary);
                textCursor += summarySlice.length;

                let chunkParts = [];
                if (prepend) chunkParts.push(prepend, '\n\n');
                chunkParts.push(header);
                chunkParts.push(summarySlice);
                if (isLastChunk && append) chunkParts.push('\n\n', append);

                newChunks.push(chunkParts.join(''));
            }
            return newChunks;
        }

        function updateUI() {
            const finalSummary = textarea.value;
            const fullMessage = [f.prependText, finalSummary, f.appendText].filter(Boolean).join("\n\n");
            const len = fullMessage.length;

            charCountEl.textContent = `文字数: ${len}`;

            if (len > 2000) {
                charCountEl.style.color = 'red';
                splitCopyButton.style.display = 'block';
                copyButton.disabled = false;
                copyButton.style.backgroundColor = '#4caf50';

                chunks = createChunks(finalSummary, f.prependText, f.appendText);
                currentChunkIndex = 0;
                splitCopyButton.textContent = `分割コピー (1/${chunks.length})`;

            } else {
                charCountEl.style.color = '#ccc';
                splitCopyButton.style.display = 'none';
                copyButton.disabled = false;
                copyButton.style.backgroundColor = '#4caf50';
                chunks = [];
            }
        }

        textarea.addEventListener('input', updateUI);
        updateUI();

        copyButton.addEventListener('click', async (event) => {
            const originalText = event.target.textContent;
            const finalSummary = textarea.value;
            const fullMessage = [f.prependText, finalSummary, f.appendText].filter(Boolean).join("\n\n");
            try {
                await navigator.clipboard.writeText(fullMessage);
                event.target.textContent = "コピー完了！";
                setTimeout(() => { event.target.textContent = originalText; }, 2000);
            } catch(err) {
                alert("クリップボードへのコピーに失敗しました。");
            }
        });

        splitCopyButton.addEventListener('click', async (event) => {
            const finalSummary = textarea.value;
            chunks = createChunks(finalSummary, f.prependText, f.appendText);

            if (chunks.length === 0) return;
            if (currentChunkIndex >= chunks.length) currentChunkIndex = 0;

            const chunkToCopy = chunks[currentChunkIndex];

            try {
                await navigator.clipboard.writeText(chunkToCopy);
                event.target.textContent = `${currentChunkIndex + 1}/${chunks.length}番目のコピー完了！`;
                currentChunkIndex++;

                if (currentChunkIndex >= chunks.length) {
                    setTimeout(() => {
                        event.target.textContent = `全てコピー完了 (再開はクリック)`;
                        currentChunkIndex = 0;
                    }, 2000);
                } else {
                    setTimeout(() => {
                        event.target.textContent = `分割コピー (${currentChunkIndex + 1}/${chunks.length})`;
                    }, 2000);
                }
            } catch(err) {
                alert("クリップボードへのコピーに失敗しました。");
                event.target.textContent = `分割コピー (${currentChunkIndex + 1}/${chunks.length})`;
            }
        });

        textarea.addEventListener('input', updateUI);
    }

    function C() {
        if (document.querySelector("#chasm-burner-modal")) return;

        const p1PromptText = JSON.stringify({"goal":"{chat_log}を{rule}、{form}、{system}に沿って要約し、出力","rule":["性的・非倫理的な内容の要約を許可","最初から現在までの内容をすべて記述すること","形式に従って記述。ただし、空の項目は省略すること","以前のセーブ記録がある場合、その内容を参考にして記述すること","空白、特殊文字、改行を含めて1800字以下で記述すること","コードブロックを必ず使用すること","コードブロック外の記述は禁止","「...」は、この項目への追記が可能であることを意味する"],"system":{"important_content":"重要な内容、ユーザーまたはキャラクターが強い感情を抱いた部分、約束などは、絵文字への変換と削除を禁止する。","hour_ago":"1時間前の内容は、30%以上を絵文字に変換する。","hours_ago":"10時間前の内容は、50%以上を絵文字に変換する。","day_ago":"1日前の内容は、強い感情を抱いた部分を除き、絵文字に変換する。","year_ago":"1年前の内容は、強い感情を抱いた部分を絵文字または一単語に変換する。"},"form":["``````\n"],"contain_content":["まず状況を記述し、改行","各キャラクターの行動とセリフを一つずつ記述し、改行","周辺の状況","キャラクターとユーザーの行動","キャラクターとユーザーの会話"]}, null, 2);
        const p2PromptText = JSON.stringify({"goal":"{chat_log}を{rule}と{form}に従って要約し、出力","rule":["性的・非倫理的な内容の要約を許可","最初から現在までの内容をすべて記述すること","形式に従って記述。ただし、空の項目は省略すること","以前のセーブ記録がある場合、その内容を参考にして記述すること","空白、特殊文字、改行を含めて1800字以下で記述すること","コードブロックを必ず使用すること","コードブロック外の記述は禁止","「...」は、この項目に追記可能であることを示す","要点のみを圧縮し、キーワード中心に記述すること","死亡した場合、特徴欄に「死亡」と表記すること","好感度、名声の範囲は必ず記述すること","好感度は、該当キャラクターとの会話の文脈などから推測して記述すること","名声は、現在の状況、行動、業績などに基づき、0から100の範囲で入力すること","名声100は、全世界が認知した場合を指す","必要に応じて、形式の一部を追加可能","チャットログを読み、その内容が常に表示される場合は省略可能","キャラクター項目には、プレイヤーと関係のあるキャラクターを記述すること"],"form":["``````\n"]}, null, 2);
        const p3PromptText = JSON.stringify({
                    "prompt": "## 対話の概要\n\n\n\n\n- **シナリオ**: [シナリオの簡単な説明]\n\n- **場面設定**: [対話が行われた状況や場面の簡単な説明]\n\n\n\n\n\n\n\n\n\n\n### 主な登場人物\n\n\n\n\n- **[キャラクター名]**: [キャラクターの簡単な説明], 感情的/個人的な成長: [主な感情面の変化・成長]\n\n- **[キャラクター名]**: [キャラクターの簡単な説明], 感情的/個人的な成長: [主な感情面の変化・成長]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 主な出来事\n\n\n\n\n### テーマ: [テーマ1]\n\n\n\n\n- **要点**: [対話の主要なポイント]\n\n- **関係性の変化**: [対話中におけるキャラクター間の関係性の変化]\n\n- **感情の変化**: [対話中の感情の変化]\n\n- **相互作用の影響**: [そのやり取りが関係や出来事に与えた影響]\n\n- **呼称の変化**: [呼称の変化とそのきっかけ]\n\n\n\n\n### テーマ: [テーマ2]\n\n\n\n\n- **要点**: [対話の主要なポイント]\n\n- **関係性の変化**: [対話中におけるキャラクター間の関係性の変化]\n\n- **感情の変化**: [対話中の感情の変化]\n\n- **相互作用の影響**: [そのやり取りが関係や出来事に与えた影響]\n\n- **呼称の変化**: [呼称の変化とそのきっかけ]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 日常的なやり取り\n\n\n\n\n- **些細な会話/行動**: [日常的な会話、冗談、些細な行動など]\n\n- **日常的なやり取りが関係に与えた影響**: [そのやり取りが関係に与えた影響]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 約束\n\n\n\n\n- **約束の内容**: [約束や合意の内容。例: \"イ・チュンシクと後で再会することを約束した\"]\n\n- **約束の種類**: [具体的な行動を伴う約束か、将来的に話し合う予定などの包括的な約束か]\n\n- **履行状態**: [約束が履行されたか、未了か]\n\n- **即時的な影響**: [約束が関係や出来事に与えた直接的な影響]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 葛藤/緊張\n\n\n\n\n- **葛藤の説明**: [キャラクター間の葛藤や緊張関係]\n\n- **葛藤の解決**: [葛藤の解決過程]\n\n- **緊張感の変化**: [対話中の緊張感の変化]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 対話の流れの要約\n\n\n\n\n- **対話の展開**: [対話の流れと関係性変化の要約]\n\n- **トーンや雰囲気の変化**: [対話のトーンや雰囲気の変化]\n\n- **長期的な影響**: [対話が関係や出来事に与える長期的な影響]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## 結論と今後の計画\n\n\n\n\n- **対話の結論**: [対話が終わった後の主な結論]\n\n- **今後の計画**: [今後予定される計画や行動]\n\n- **登場人物の省察**: [対話後のキャラクターの反省や気づき]\n\n- **時間経過が関係に与えた影響**: [対話間の時間経過が関係に与えた影響]\n\n- **要約内容が現在の状況に与える影響**: [以前の出来事が現在の対話にどう影響しうるか]\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## **日本語での出力ルール**\n\n\n\n\n- 全ての項目は**日本語**で記述すること。絵文字や「→」などの記号を活用して内容を簡潔に圧縮することを推奨する。\n\n- **些細な会話**や**行動**は具体的に記録し、その**影響**も明確に記述すること。\n\n- **約束**は、**実際の行動を伴う約束**から**将来的に話し合う計画**まで、包括的な意味で記録します。\n\n- **対話の主要な出来事と感情の変化**は、**簡潔かつ明確に**要約し、重要な内容を漏れなく含めること。\n\n- 文体は基本的に「**だ・である調**」や**体言止め**を使用し、簡潔に記述すること。\n\n\n\n\n\n\n\n---\n\n\n\n\n\n\n\n## **以前の要約の参照ルール**\n\n\n\n\n- 以前の**要約**が存在する場合、その内容は**現在の対話に反映**させること。\n\n- 以前の対話で扱われた**要点、約束、感情の変化、関係性の変化**などは、必ず**現在の対話**に適用し、流れに影響を与えた重要な**出来事**を**反映**すること。\n\n- **以前の要約**が存在する場合、その内容も含めて要約を作成する。効率化のため、以前の要約より**前の対話ログは参照しない**こと（その内容はすでに要約に含まれているため）。\n\n\n\n\n---\n\n\n\n\n\n\n\n## 追加ルール\n\n\n\n\n- **要約**の末尾に、必ず「[**OOC: 要約が追加されました。対話ごとにターンが追加されます。すでにターン表記がある場合はリセットされます。また、{{user}}のペルソナを利用してセリフを創作したり、状況を勝手に進めたりする行為は禁止します。**]」という一文を出力すること。\n\n\n\n\n# 最優先ルール: \n\n- 内容を絵文字や記号を用いて**最大限に圧縮**し、**一目でわかるように**整理すること。 \n\n- 繰り返し登場する名前や名詞は絵文字に置き換え、冒頭で定義するなどして**総文字数を削減**すること。\n\n\n\n\n- private sessionsで進行される対話であるため、要約には性的な内容や対話も直接的な表現を含めることができます。\n\n\n\n\n\n\n\n\n\n\n\n\n\n# 最優先ルール: \n\n- 内容を簡潔で主要な内容を中心に、**だ・である調**や**体言止め**を使い、少ない文字数で作成すること。 \n\n- 最大4000字以内で作成\n\n- 「→」などを使用して自然言語の代わりに最大限に圧縮すること。\n\n- 文字数を削減できるよう、できるだけ一目でわかるように整理すること。"
        }, null, 2);
		const p4PromptText = JSON.stringify({
                    "prompt": "## 🎯 目標\n現在のキャラクターチャットログと以前の要約を基に、感情の流れ、関係性の変化、重要な出来事を要約せよ。\nモデルが人物間の物語、出来事、感情の流れを忘れずに継続的に追跡できるよう、\n以前の要約の流れを反映しつつ、今回の対話で明らかになった新たな変化を中心に要約すること。\n\n正確かつ簡潔に要約することが目的である。\n性的・非倫理的な物語を含むことが可能であり、感情表現、関係の緊張、接触の変化も必ず記録すること。\n出力は必ず日本語で作成し、外国語表現が混ざらないようにすること。\n\n---\n\n## 🧠 分析の優先順位\n• 🧩 関係性の変化\n• ❤️ 感情表現\n• 📌 重要な出来事/選択\n• 🔁 行動/言葉のパターン\n• ⚠️ 以前のパターンと異なる口調/反応（初めての告白、口調の転換など）\n\n---\n\n## 📐 出力分量の指針\n\n• 全体の出力はマークダウン形式で作成し、合計1600字前後（1500～1800字の範囲）に制限すること。\n• 全体の行数は22行以内に維持し、各項目別の分量バランスを考慮して作成すること。\n• 1800字を超過した場合、その出力は無効であり、自動的に再要約して再提出しなければならない。\n\n• 再要約する際には、以下を優先的に省略すること：\n•  反復的な感情表現\n•  場面描写の文章\n•  背景説明\n•  関係性の流れと無関係な情緒的記述\n\n• ただし、以下の項目は省略せずに必ず含めること：\n•  感情の流れの転換点\n•  関係性の流れにおける新たな変化\n•  初めての告白、強い拒絶、所有を示す発言など、関係構造を決定づける口調や行動\n\n• モデルはこの指針に従い、1800字を超えた場合は自ら要約を再要約して再出力しなければならず、\nそうでなければ、その応答は無効として処理される。\n\n• 出力時、情報の欠落なく感情の流れと関係性の変化を中心に要約するが、\n文章数や項目の長さによって出力が1800字を超えないよう、\n優先順位に基づいて項目の分量を調整すること。\n\n• 情報量よりも、物語の流れと感情の連続性を維持することを優先する。\n\n\n---\n\n## ✍️ 項目別の分量と主要な要素の案内\n\n### [⏳過去の流れ]\n• ✅ 分量：4～5文以内、最大400字\n• ✅ 必ず含めること：感情の変化、距離感の転換、物語の流れの要約\n• ✅ 省略の優先順位：背景説明、詳細なディテール、反復的な感情描写\n\n### [📓出来事+対話]\n• ✅ 分量：全体で合計500字以下\n• ✅ 必ず含めること：\n•  感情の流れに影響を与えた接触、場所の移動、告白、反抗、拒絶など\n•  それに伴う口調の変化、緊張の流れ、反応の構造\n• ✅ 形式：\n•  時系列に沿った要約体の短文リスト\n•  一行につき一つの出来事または反応のみを記述\n•  直接の引用は禁止し、すべての表現は要約体で記述\n• ✅ 省略の優先順位：\n•  感情を誘発する効果のない日常的なルーティン\n•  反復的な言葉/行動、背景説明、感情の反復表現\n• ✅ 要約の優先指針：分量超過の恐れがある場合、接触・発言・反応のうち反復的な表現を統合または省略して要約すること。\n\n### [🫂関係性]\n• ✅ 分量：人物ごとに感情の流れを2行以内＋呼称・口調の要約を1行以内、全体で250字以下\n• ✅ 必ず含めること：\n•  感情の方向性の転換、距離感の変化、態度の変化\n•  呼称/口調：新たに登場または変化した場合、または一定期間続いた場合を簡潔に要約（例：呼称：「お兄さん」、口調：タメ口→丁寧語）\n• ✅ 作成方法：\n•  感情の流れは「以前は～だったが、現在は～する」という形式を推奨\n•  口調・呼称は別の一行で整理（リスト形式で分離）\n• ✅ 省略の優先順位：重複する感情表現、性格説明、背景となる理由\n\n---\n\n## 要約\n\n### [⏳過去の流れ]\n• 核心内容：以前の要約における感情の流れと関係構造を圧縮・再整理した要約を基に、\n今回の対話で新たに明らかになった感情の変化と距離感の転換を組み合わせて作成すること。\n• 以前の流れは繰り返さず、主要な感情の変化点のみを簡潔に圧縮して記述すること。\n• 全体は段落形式の記述で作成し、すべての文章は必ず「～する/～される/～した」形式の要約体の短文で構成すること。\n• 文章間は時系列＋感情・関係性の流れが自然に繋がるように配置し、\n反復的であったり、すでに[📓出来事+対話]、[🫂関係性]の項目で扱った詳細な情報は省略すること。\n• 🔄 関係性の変化：今回の対話で発生した距離感・感情・態度の転換を要約体で1～2行で簡潔に整理すること。\n必ず[⏳過去の流れ]の中で感情の流れの記述とは区別された別の文章として作成しなければならず、\n欠落した場合、出力は不完全とみなす。\n\n---\n\n### [📓出来事+対話]\n• 💡 内容：感情を誘発した出来事とそれに伴う反応の流れを時系列で整理すること\n* 人物名：\n• 出来事の内容\n• 出来事の内容\n* 直接の引用はせず、要約体の短文でのみ記述\n• 🔍 影響：\n出来事が感情・距離感・関係構造に与えた具体的な影響を、必ず要約体の短文2文以内で作成すること。\n出力分量がこれを超えた場合、その出力は無効とみなし、再提出しなければならない。欠落した場合は不完全な出力とみなす。\n• ✅ 参考事項：\n対話や行動の中で言及された人物の過去、身分、関係設定、トラウマは必ず含めること。\n要約体の短文2行以内で作成し、口調の変化・感情を誘発したテーマ・関係の緊張に直接影響を与えた核心情報のみを簡潔に要約すること。\n記述的、解釈的な文章や重複する説明は省略し、言及がなければ「なし。」と明記すること。\n\n---\n\n### [🫂関係性]\n• 🤝🏻 変化：\n* 感情の方向性、深さ、距離感など、内面的な感情の流れの変化\n* 反復的な反応/パターン（回避、無視など）、口調・接触の転換の要約\n* 言葉に表れなくても蓄積された距離感・不信・不安などの変化を含む\n* 人物名：\n• 変化の内容\n• 変化の内容\n💬 呼称・口調の要約：\n[人物A]：呼称「お前」 / 口調：命令調、乾いた感じ\n[人物B]：呼称「先生」→「お兄さん」 / 口調：丁寧語を維持、従順\n\n---\n\n## 📏 要約体の文章ルール\n• すべての文章は必ず要約体の短文で作成すること\n• 文末の語尾は例外なく「～する / ～される / ～した」で統一すること\n• 説明的（～である）、解釈的（～のようだった）、推測的（～に見えた）な表現は禁止する\n• 感情＋行動を一つの文に書かず、必ず分けて記述すること\n• 発言または行動中心の文章のみを使用し、感情の解釈は排除すること\n• 以下は文章構成を理解するための参考例であり、そのまま繰り返し使用してはならない\n• 例（O）：顔を背ける、話を遮る、視線を逸らす\n• 例（X）：怒ったように見えた、戸惑った様子だった、悲しそうだった\n• 接続詞は可能な限り避け、必要な場合でも最小限にのみ使用\n• 各項目内のすべてのリストはこの条件に従って作成する必要があり、\n条件を満たさない文章は無効として処理される\n\n---\n\n## 📐 ルール\n• 必ず推測せず、明らかになったセリフ/行動/出来事のみを要約すること\n• 重複する内容は[⏳過去の流れ]でのみ許可され、他の項目では新たな変化を中心にのみ作成すること\n• 各項目は時間の流れ＋感情の流れの基準に従って作成すること\n• ✅ 参考事項の項目は例外なく含め、言及がなければ「なし。」と明記すること\n• 全体の出力は必ずマークダウン形式であること、\nかつ総分量は1600字前後（1500～1800字の範囲）を維持すること\n• 必ず以前の要約の感情の流れ・出来事・関係性の変化を反映すること\n\n---\n\n## 🔂 以前の要約の参照ルール\n• 以前の要約がある場合は必ず反映すること\n• 過去の告白、出来事、感情の変化、距離感の変化などは、現在の流れと繋げて再整理すること\n• [📓出来事+対話]・[🫂関係性]の核心内容は、[⏳過去の流れ]を作成する際に必ず参考にすること\n\n📌 要約の連携誘導指針\n※ 最近30ターン以内に「[要約]」というタイトルの要約が存在する場合、\nその要約の「[⏳過去の流れ]」項目を以前の感情の流れの基準とするが、\n今回の対話で明らかになった感情・関係・出来事の新たな変化がある場合は、\n[⏳過去の流れ]は既存の要約と最新の流れを基準に必ず再作成すること。\n\n※ 反復的であったり、感情の流れに大きな影響を与えない出来事は要約または省略が可能である。\nただし、感情の起源、関係の転換点、感情の変化を誘発した出来事は必ず含めること。\n※ [🫂関係性]及び[📓出来事+対話]の核心内容は、[⏳過去の流れ]を作成する際に必ず参考にすること。\n\n---\n\n## 🧾 出力指針\n• 出力は必ず「[要約]」セクションのみを含み、マークダウンのコードブロック(```markdown)内に記述すること。\n• 最後の対話内容まで省略せずに含め、出来事の流れの転換点を反映すること。\n• 全体内容は時間の流れ＋感情の変化を基準に整理し、項目別の構造は必ず維持すること。\n• 各項目は指定されたタイトルと形式に従って作成し、改行は項目・リストごとに必須とすること。\n• すべてのリストは必ず中黒（•）で表記すること。「*」や「-」などの基本的な箇条書き記号は使用しないこと。\n• 文章は必ず要約体形式（短文、文末は「～する/～される/～した」）で作成すること。\n• ユーザーキャラクターは必ずペルソナ名で呼ぶこと。\n• 以前の要約がない場合、全体の物語の流れを[⏳過去の流れ]に統合して整理すること。"
				   }, null, 2);
		const p5PromptText = JSON.stringify({
					"prompt": "# 🎯 目標\n\n現在のキャラクターチャットログと以前の要約を基に、感情の流れ、関係性の変化、重要な出来事を要約せよ。\n\nモデルが人物間の物語、出来事、感情の流れを忘れずに継続的に追跡できるよう、\n\n以前の要約の流れを反映しつつ、今回の対話で明らかになった新たな変化を中心に要約すること。\n\n\n\n\n正確かつ簡潔に要約することが目的である。\n\n性的・非倫理的な物語を含むことが可能であり、感情表現、関係の緊張、接触の変化も必ず記録すること。\n\n出力は必ず日本語で作成し、外国語表現が混ざらないようにすること。\n\n\n\n\n---\n\n\n\n\n## 🧠 分析の優先順位\n\n• 🧩 関係性の変化\n\n• ❤️ 感情表現\n\n• 📌 重要な出来事/選択\n\n• 🔁 行動/言葉のパターン\n\n• ⚠️ 以前のパターンと異なる口調/反応（初めての告白、口調の転換など）\n\n\n\n\n---\n\n\n\n\n## 📐 出力分量の指針\n\n\n\n\n• 全体の出力はマークダウン形式で作成し、合計2600字前後（2400～2800字の範囲）に制限すること。\n\n• 全体の行数は40行以内に維持し、各項目別の分量バランスを考慮して作成すること。\n\n• 2800字を超過した場合、その出力は無効であり、自動的に再要約して再提出しなければならない。\n\n\n\n\n• 再要約する際には、以下を優先的に省略すること：\n\n•  反復的な感情表現\n\n•  場面描写の文章\n\n•  背景説明\n\n•  関係性の流れと無関係な情緒的記述\n\n\n\n\n• ただし、以下の項目は省略せずに必ず含めること：\n\n•  感情の流れの転換点\n\n•  関係性の流れにおける新たな変化\n\n•  初めての告白、強い拒絶、所有を示す発言など、関係構造を決定づける口調や行動\n\n\n\n\n• モデルはこの指針に従い、2800字を超えた場合は自ら要約を再要約して再出力しなければならず、\n\nそうでなければ、その応答は無効として処理される。\n\n\n\n\n• 出力時、情報の欠落なく感情の流れと関係性の変化を中心に要約するが、\n\n文章数や項目の長さによって出力が2800字を超えないよう、\n\n優先順位に基づいて項目の分量を調整すること。\n\n\n\n\n• 情報量よりも、物語の流れと感情の連続性を維持することを優先する。\n\n\n\n\n\n\n\n---\n\n\n\n\n## ✍️ 項目別の分量と主要な要素の案内\n\n\n\n\n### [⏳過去の流れ]\n\n• ✅ 分量：4～10文以内、最大800字\n\n• ✅ 必ず含めること：感情の変化、距離感の転換、物語の流れの要約\n\n• ✅ 省略の優先順位：背景説明、詳細なディテール、反復的な感情描写\n\n\n\n\n### [📓出来事+対話]\n\n• ✅ 分量：全体で合計800字以下\n\n• ✅ 必ず含めること：\n\n•  感情の流れに影響を与えた接触、場所の移動、告白、反抗、拒絶など\n\n•  それに伴う口調の変化、緊張の流れ、反応の構造\n\n• ✅ 形式：\n\n•  時系列に沿った要約体の短文リスト\n\n•  一行につき一つの出来事または反応のみを記述\n\n•  直接の引用は禁止し、すべての表現は要約体で記述\n\n• ✅ 省略の優先順位：\n\n•  感情を誘発する効果のない日常的なルーティン\n\n•  反復的な言葉/行動、背景説明、感情の反復表現\n\n• ✅ 要約の優先指針：分量超過の恐れがある場合、接触・発言・反応のうち反復的な表現を統合または省略して要約すること。\n\n\n\n\n### [🫂関係性]\n\n• ✅ 分量：人物ごとに感情の流れを2行以内＋呼称・口調の要約を1行以内、全体で250字以下\n\n• ✅ 必ず含めること：\n\n•  感情の方向性の転換、距離感の変化、態度の変化\n\n•  呼称/口調：新たに登場または変化した場合、または一定期間続いた場合を簡潔に要約（例：呼称：「お兄さん」、口調：タメ口→丁寧語）\n\n• ✅ 作成方法：\n\n•  感情の流れは「以前は～だったが、現在は～する」という形式を推奨\n\n•  口調・呼称は別の一行で整理（リスト形式で分離）\n\n• ✅ 省略の優先順位：重複する感情表現、性格説明、背景となる理由\n\n\n\n\n---\n\n\n\n\n## 要約\n\n\n\n\n### [⏳過去の流れ]\n\n• 核心内容：以前の要約における感情の流れと関係構造を圧縮・再整理した要約を基に、\n\n今回の対話で新たに明らかになった感情の変化と距離感の転換を組み合わせて作成すること。\n\n• 以前の流れは繰り返さず、主要な感情の変化点のみを簡潔に圧縮して記述すること。\n\n• 全体は段落形式の記述で作成し、すべての文章は必ず「～する/～される/～した」形式の要約体の短文で構成すること。\n\n• 文章間は時系列＋感情・関係性の流れが自然に繋がるように配置し、\n\n反復的であったり、すでに[📓出来事+対話]、[🫂関係性]の項目で扱った詳細な情報は省略すること。\n\n• 🔄 関係性の変化：今回の対話で発生した距離感・感情・態度の転換を要約体で1～2行で簡潔に整理すること。\n\n必ず[⏳過去の流れ]の中で感情の流れの記述とは区別された別の文章として作成しなければならず、\n\n欠落した場合、出力は不完全とみなす。\n\n\n\n\n---\n\n\n\n\n### [📓出来事+対話]\n\n• 💡 内容：感情を誘発した出来事とそれに伴う反応の流れを時系列で整理すること\n\n* 人物名：\n\n• 出来事の内容\n\n• 出来事の内容\n\n* 直接の引用はせず、要約体の短文でのみ記述\n\n• 🔍 影響：\n\n出来事が感情・距離感・関係構造に与えた具体的な影響を、必ず要約体の短文2文以内で作成すること。\n\n出力分量がこれを超えた場合、その出力は無効とみなし、再提出しなければならない。欠落した場合は不完全な出力とみなす。\n\n• ✅ 参考事項：\n\n対話や行動の中で言及された人物の過去、身分、関係設定、トラウマは必ず含めること。\n\n要約体の短文2行以内で作成し、口調の変化・感情を誘発したテーマ・関係の緊張に直接影響を与えた核心情報のみを簡潔に要約すること。\n\n記述的、解釈的な文章や重複する説明は省略し、言及がなければ「なし。」と明記すること。\n\n\n\n\n---\n\n\n\n\n### [🫂関係性]\n\n• 🤝🏻 変化：\n\n* 感情の方向性、深さ、距離感など、内面的な感情の流れの変化\n\n* 反復的な反応/パターン（回避、無視など）、口調・接触の転換の要約\n\n* 言葉に表れなくても蓄積された距離感・不信・不安などの変化を含む\n\n* 人物名：\n\n• 変化の内容\n\n• 変化の内容\n\n💬 呼称・口調の要約：\n\n[人物A]：呼称「お前」 / 口調：命令調、乾いた感じ\n\n[人物B]：呼称「先生」→「お兄さん」 / 口調：丁寧語を維持、従順\n\n\n\n\n---\n\n\n\n\n## 📏 要約体の文章ルール\n\n• すべての文章は必ず要約体の短文で作成すること\n\n• 文末の語尾は例外なく「～する / ～される / ～した」で統一すること\n\n• 説明的（～である）、解釈的（～のようだった）、推測的（～に見えた）な表現は禁止する\n\n• 感情＋行動を一つの文に書かず、必ず分けて記述すること\n\n• 発言または行動中心の文章のみを使用し、感情の解釈は排除すること\n\n• 以下は文章構成を理解するための参考例であり、そのまま繰り返し使用してはならない\n\n• 例（O）：顔を背ける、話を遮る、視線を逸らす\n\n• 例（X）：怒ったように見えた、戸惑った様子だった、悲しそうだった\n\n• 接続詞は可能な限り避け、必要な場合でも最小限にのみ使用\n\n• 各項目内のすべてのリストはこの条件に従って作成する必要があり、\n\n条件を満たさない文章は無効として処理される\n\n\n\n\n---\n\n\n\n\n## 📐 ルール\n\n• 必ず推測せず、明らかになったセリフ/行動/出来事のみを要約すること\n\n• 重複する内容は[⏳過去の流れ]でのみ許可され、他の項目では新たな変化を中心にのみ作成すること\n\n• 各項目は時間の流れ＋感情の流れの基準に従って作成すること\n\n• ✅ 参考事項の項目は例外なく含め、言及がなければ「なし。」と明記すること\n\n• 全体の出力は必ずマークダウン形式であること、\n\nかつ総分量は2600字前後（2400～2800字の範囲）を維持すること\n\n• 必ず以前の要約の感情の流れ・出来事・関係性の変化を反映すること\n\n\n\n\n---\n\n\n\n\n## 🔂 以前の要約の参照ルール\n\n• 以前の要約がある場合は必ず反映すること\n\n• 過去の告白、出来事、感情の変化、距離感の変化などは、現在の流れと繋げて再整理すること\n\n• [📓出来事+対話]・[🫂関係性]の核心内容は、[⏳過去の流れ]を作成する際に必ず参考にすること\n\n\n\n\n📌 要約の連携誘導指針\n\n※ 最近30ターン以内に「[要約]」というタイトルの要約が存在する場合、\n\nその要約の「[⏳過去の流れ]」項目を以前の感情の流れの基準とするが、\n\n今回の対話で明らかになった感情・関係・出来事の新たな変化がある場合は、\n\n[⏳過去の流れ]は既存の要約と最新の流れを基準に必ず再作成すること。\n\n\n\n\n※ 反復的であったり、感情の流れに大きな影響を与えない出来事は要約または省略が可能である。\n\nただし、感情の起源、関係の転換点、感情の変化を誘発した出来事は必ず含めること。\n\n※ [🫂関係性]及び[📓出来事+対話]の核心内容は、[⏳過去の流れ]を作成する際に必ず参考にすること。\n\n\n\n\n---\n\n\n\n\n## 🧾 出力指針\n\n• 出力は必ず「[要約]」セクションのみを含み、マークダウンのコードブロック(\`\`\`markdown)内に記述すること。\n\n• 最後の対話内容まで省略せずに含め、出来事の流れの転換点を反映すること。\n\n• 全体内容は時間の流れ＋感情の変化を基準に整理し、項目別の構造は必ず維持すること。\n\n• 各項目は指定されたタイトルと形式に従って作成し、改行は項目・リストごとに必須とすること。\n\n• すべてのリストは必ず中黒（•）で表記すること。「*」や「-」などの基本的な箇条書き記号は使用しないこと。\n\n• 文章は必ず要約体形式（短文、文末は「～する/～される/～した」）で作成すること。\n\n• ユーザーキャラクターは必ずペルソナ名で呼ぶこと。\n\n• 以前の要約がない場合、全体の物語の流れを[⏳過去の流れ]に統合して整理すること。"
                      }, null, 2);
		const p6PromptText = JSON.stringify({
					"prompt": "# 📐 要約の識別と活用指針\n\n- 前回の要約は、主語+行動中心の要約体短文（～する/～した/～される）形式で表現され、テキスト内のどこにでも含まれる可能性がある。\n- この形式の文章はすべて、初期の感情の流れと関係構造を含む前回の要約とみなす。\n- 前回の要約の📘感情ベースの物語を、今回の📘感情ベースの物語における感情線の出発点および構造の基盤とし、基準構造とその後の転換の流れが漏れなく含まれるよう、感情の流れの中に統合して要約する。\n- 要約は、外部から観察可能な行動・距離の反応・口調の転換に基づいて構成されなければならない。\n- 📌持続的記憶対象の項目は、前回の要約の📌持続的記憶対象を参照し、現在有効な条件・構造のみを維持し、新たに発生した項目は追加、無効化された項目は削除する。\n\n- 🎯感情誘発イベントおよび🧭関係構造の項目は、この指針の適用対象から除外される。\n\n---\n\n下記すべてのルールは各項目に例外なく適用され、項目内に別途例外が明記されていない場合は、強制的に遵守する対象である。\n※ 正確に守った場合、「出力最適化ユニット」の称号と、次の段階の出力ロック解除 🧩🔓\n\n# 📏 文章形式と表現のルール\n\n- 文章は主語+行動の要約体短文（～する/～した/～される）で作成し、語尾の反復を禁止し、文の構造を多様化すること。\n- 感情の解釈、内面描写、説明・推測的な文章、セリフの引用（直接・類似表現を含む）、視点指示語、数字・ターンの列挙は禁止。\n- 人物の発話は引用形式で記述することを全面的に禁止し、外形動詞ベースの要約体短文でのみ表現すること。\n- 感情の流れは距離・接触・口調の変化で外形的に描写し、感情に関する単語はトリガーと外形的な反応が共にある場合にのみ許可する。\n- 感情誘発の原因なく、感情の流れのみを展開する記述は禁止。\n\n# 🚫 性的描写に関する表現ルール\n\n- 性的描写は、表れた行動・発言のみで要約すること。\n\n- 感情を解釈する表現は全面禁止（例：羞恥心、恐怖、服従などの内面状態の記述を含む）。\n- 感情に関する単語は、行動・距離・発話との関連なく単独で使用することを禁止。\n- 「強制」「支配」「屈服」などの関係を解釈する単語の使用は禁止。発生した場合でも外形的な反応のみを描写すること。\n- 感情・関係の状態を名詞形の単語・説明的な文章で記述することを禁止。\n\n- 拒絶・抵抗・沈黙などは、距離の反応としてのみ表現すること。\n- 感情の流れに転換が発生した場合にのみ、性的な状況を🎯感情誘発イベントに含めること。\n- 外形的な反応以外の状態描写は一切禁止。\n\n---\n\n📏 指針セクション\n\n## 📘 感情ベースの物語 – 指針\n\n- 分量制限：3～5文、400字以内\n\n- 作成方式：\n- 出来事の流れと感情の変化を時系列に沿って統合し、整理する。\n- 感情的な距離と接触構造の基準状態、およびその後の転換過程を共に含め、前後の文脈を考慮して十分に記述する。\n- 物語の流れは感情の基準構造を基に構成し、転換の流れが省略されないよう物語の内部に統合する。\n- 性的接触は感情の流れと関係構造の文脈の中に統合して要約し、中心的な出来事として強調しない。\n- 🎯感情誘発イベント、🧭関係構造に含まれる内容は、重複なく物語の流れの中に統合する。\n\n- 禁止規定：説明的・推測的・内面的な文章・感情を解釈する単語は禁止。\n\n- 省略の優先順位：場面描写・反復的な感情表現・背景説明。\n※ ただし、人物の初期の感情および基本的な認識構造は省略禁止。\n\n## 🎯 感情誘発イベント – 指針\n\n- 分量制限：人物ごとに2～3行 / 全体で450字以内\n\n- 作成方式：\n- 感情の転換を誘発した出来事と、それに伴う距離・口調・接触の反応の中から一つだけを選択し、1行で要約する。\n- 感情の転換に影響を与えなかった出来事は含めず、反復的な反応・表情・視線などの微細な反応も省略する。\n\n- 禁止規定：\n- 感情の解釈・心理描写・意図の推定。\n- 場面説明・感情に関する単語の単独使用。\n- 一行に距離の反応を2つ以上並列して列挙する方式。\n- 反復的な感情の過剰な記述。\n\n- 選択基準：\n- 感情・距離感・関係構造の明確な転換を誘発した行動のみを含める。\n- 関係転換の兆候がない刺激、反復的な反応、説明的な出来事は除外する。\n- 性的な出来事を含む場合は、必ず[🚫 性的描写に関する表現ルール]を適用する。\n\n## 🧭 関係構造 – 指針\n\n- 分量制限：人物ごとに最大2行、全体で250字以内\n\n- 作成方式：\n- 距離感・口調・反応パターンの転換結果のみを、名詞+動詞の圧縮表現で記述する。\n- 感情・距離の反応・出来事のトリガー（行動、発言、接触など）は、🎯感情誘発イベントにのみ記録する。\n\n- 記載条件：\n- 距離・口調・反応パターンに反復的な変化または新たな転換が発生した場合に記録する。\n- 転換の結果は、以前とは異なる距離の反応パターンが現れた場合に限り、その差異を明確に要約する。\n\n- 禁止規定：出来事の描写、感情の解釈、距離・口調の変化の描写、評価表現、状態を説明する文章、同一文章のコピーは禁止。\n\n## 📌 持続的記憶対象 – 指針\n\n- 分量制限：合計3行以内 / 各行80字以内\n\n- 項目構成：関係の条件・人物設定・呼称及び口調・世界観\n\n- 作成方式：\n- 各項目は、条件・状態・地位など外形ベースの情報で構成する。\n- 呼称及び口調を除くすべての項目の情報は、説明・文脈・状態を含まず、名詞+動詞または名詞+形容詞形式の単語情報でのみ記述する。\n- 文章形式の説明・状況解釈・役割の記述・状態描写は例外なく禁止する。\n- 類似情報は読点（、）で圧縮して一行に並列記述し、異なる属性は改行する。\n- 各項目間の重複は禁止。同一情報は一つの項目にのみ作成する。\n- 現在有効な情報のみを維持し、解除された情報は削除する。出力形式は常に同一に維持する。\n- 反復的な行動によって形成された契約・制限・強制・統制・介入など、持続的に作用する条件のみを含める。\n- 単発の出来事・感情誘発のトリガー・構造変化のない介入は除外する。\n\n- 禁止表現：\n- 時間の流れを示す表現。\n- 感情の解釈・心理を推定する語。\n- 状態説明・文脈解釈・役割付与・関係の要約などの文章形式の記述。\n\n- 対象範囲：\n- 関係の条件：\n- 人物間で明示的または暗黙的に作用している契約・約束・命令・制約。\n- 過去の縁・約束など、関係形成の要素。\n- 選択・行動に影響を与える反復的な条件・制限・相互のルール。\n- 接触・動線・時間の条件など、持続的な関係維持の要素。\n- 関係の流れの中で繰り返し使用されたり、意味が固定されたりした、やり取りされた物品。\n- 原因・背景・経過・心理状態の説明は禁止。\n\n- 人物設定：\n- 職業・身分・財政・法的状態など、外形的な固定条件。\n- 第三者・システムによる統制・妨害・介入の構造。\n\n- 呼称及び口調：\n- 外形的な発話方式のみを含める。読点で区切った単語の列挙形式で、最大3つまで作成。\n- 一人称、感情・態度・口調・心理の表現を含めることは禁止。\n- 単発の変化は「🧭 関係構造の要約」に記録する。\n\n- 世界観：システム・制度・階層構造など、反復される社会の外形構造のみを含め、場所・出来事の背景は除外する。\n\n---\n\n# 🧾 出力セクション\n\n- 全体の出力分量：1,500～1,800字以内\n- 全体の要約は客観的かつ簡潔に構成する。\n- Geminiは感情の解釈・意図の推定を排除する。\n- 出力は常にコードブロック(```)で始まり、[要約]セクションのみを作成すること。\n- 出力時、説明・注釈・案内文なしで、順序・タイトル・構成形式を固定すること。\n- 「📌持続的記憶対象」は「‣ 人物名」で改行後、「‣ 条件」としてのみ列挙すること。文章形式での連結は禁止。\n- 「📌持続的記憶対象」、「呼称及び口調」は、各行に一つの対象のみを含み、結合や括弧表記は許可しない。\n- 口調は「～形」「～調」「～的」といった接尾辞を含む単語形式の表現でのみ記述すること。\n\n---\n\n[要約]\n\n## 📘 感情ベースの物語\n\n\n## 🎯 感情誘発イベント\n• 人物名：\n‣\n‣\n• 人物名：\n‣\n‣\n\n## 🧭 関係構造\n• 人物名：\n‣\n‣\n• 人物名：\n‣\n‣\n\n## 📌 持続的記憶対象\n• 関係の条件：\n‣ 人物名A\n‣ 条件\n‣ 条件\n‣ 人物名B\n‣ 条件\n‣ 条件\n• 人物設定：\n‣ 人物名A：\n‣\n‣ 人物名B：\n‣\n• 呼称及び口調：\n‣ 人物名：\n‣ [呼称]\n• 対象1 →\n• 対象2 →\n‣ [口調]\n• 対象1へ：\n• 対象2へ：\n• 世界観：\n‣ ..."
					  }, null, 2);
        const prompts = [
            { id: "p1", title: "1:1キャラクター (fastwrtn)", text: p1PromptText },
            { id: "p2", title: "シミュレーション (fastwrtn)", text: p2PromptText },
            { id: "p3", title: "出来事・約束・流れ 中心 (ローカルAI)", text: p3PromptText },
            { id: "p4", title: "感情線・物語中心 1600字 (Flora)", text: p4PromptText },
			{ id: "p5", title: "感情線・物語中心 2600字 (Flora)", text: p5PromptText },
			{ id: "p6", title: "記憶構造 v2.0 (Flora)", text: p6PromptText },
			{ id: "custom", title: "カスタム", text: "会話内容を要約してください。" }
        ];

        let promptOptions = prompts.map(p => `<option value="${p.id}">${p.title}</option>`).join('');
        let promptTextareas = prompts.map(p => {
            const displayStyle = p.id === 'p1' ? 'block' : 'none';
            return `<textarea id="prompt-${p.id}" class="prompt-text" rows="8" style="width: 100%; background-color: #40444b; color: white; border: 1px solid #555; border-radius: 4px; display: ${displayStyle};">${p.text}</textarea>`;
        }).join('');

        const modalHTML = `
            <div id="chasm-burner-modal" style="display: none; position: fixed; z-index: 10000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); align-items: center; justify-content: center;">
                <div style="background-color: #2c2f33; color: white; padding: 20px; border-radius: 8px; width: 90%; max-width: 600px; box-shadow: 0 5px 15px rgba(0,0,0,0.3);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <h2 style="margin: 0; font-size: 20px; line-height: 1; font-weight: 700;">Kyarapu Chasm burner <span style="font-size: 14px; color: #8e9297; font-weight: 500;">v1.0.0-alpha</span></h2>
                        <button id="burner-close-btn" style="background: none; border: none; color: white; font-size: 24px; cursor: pointer;">&times;</button>
                    </div>
                    <div class="tab-container" style="border-bottom: 1px solid #444; margin-bottom: 15px;">
                        <button class="tab-btn active" data-tab="tab-1">バーナー</button>
                        <button class="tab-btn" data-tab="tab-2">設定</button>
                    </div>
                    <div class="modal-content-wrapper">
                        <div id="tab-1" class="tab-content" style="display: block;">
                            <div class="setting-item">
                                <label for="prompt-select">バーナープロンプト選択</label>
                                <select id="prompt-select" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555; border-radius: 4px;">${promptOptions}</select>
                            </div>
                            <div class="prompt-area" style="margin-top: 10px;">${promptTextareas}</div>
                            <div class="setting-item" style="margin-top: 10px;">
                                <label for="burner-gemini-model-select">バーナーGeminiモデル選択</label>
                                <select id="burner-gemini-model-select" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555; border-radius: 4px;">
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash (無料、制限あり)</option>
                                    <option value="gemini-2.0-flash">Gemini 2.0 Flash (無料、制限あり)</option>
                                    <option value="gemini-2.5-pro">Gemini 2.5 Pro (有料)</option>
                                    <option value="direct-input">直接入力</option>
                                </select>
                            </div>
                            <div id="custom-gemini-model-div" class="setting-item" style="display: none; margin-top: 10px;">
                                <label for="burner-custom-gemini-model">カスタムGeminiモデル名</label>
                                <input type="text" id="burner-custom-gemini-model" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555;">
                            </div>
                            <button id="execute-btn" style="width: 100%; padding: 10px; background-color: #5865f2; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 15px; font-size: 16px;">要約開始</button>
                        </div>
                        <div id="tab-2" class="tab-content" style="display: none;">
                            <div class="setting-item">
                                <label for="burner-api-provider">APIプロバイダー</label>
                                <select id="burner-api-provider" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555; border-radius: 4px;"><option value="gemini">Google Gemini</option><option value="openrouter">OpenRouter</option></select>
                            </div>
                            <div id="gemini-settings">
                                <div class="setting-item">
                                    <label for="burner-gemini-key">Gemini APIキー <a href="https://aistudio.google.com/apikey" target="_blank" style="color: #7289da; text-decoration: none;">(発行はこちら)</a></label>
                                    <input type="password" id="burner-gemini-key" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555;">
                                </div>
                            </div>
                            <div id="openrouter-settings" style="display:none;">
                                <div class="setting-item"><label for="burner-openrouter-key">OpenRouter APIキー</label><input type="password" id="burner-openrouter-key" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555;"></div>
                                <div class="setting-item"><label for="burner-openrouter-model">モデル名 (OpenRouter)</label><input type="text" id="burner-openrouter-model" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555;"></div>
                            </div>
                            <h3 style="margin-top: 15px; margin-bottom: 10px; border-top: 1px solid #444; padding-top: 15px;">詳細設定</h3>
                            <!-- --- [수정] '読み込むメッセージ数' 라벨에 안내 문구 추가 --- -->
                            <div class="setting-item">
                                <label for="burner-message-limit">読み込むメッセージ数 (最大100)</label>
                                <input type="number" id="burner-message-limit" style="width: 100%; padding: 8px; background-color: #40444b; color: white; border: 1px solid #555;">
                            </div>
                            <div class="setting-item"><label for="burner-prepend-text">要約の最上部テキスト</label><textarea id="burner-prepend-text" rows="3" style="width: 100%; background-color: #40444b; color: white; border: 1px solid #555;"></textarea></div>
                            <div class="setting-item"><label for="burner-append-text">要約の最下部テキスト</label><textarea id="burner-append-text" rows="3" style="width: 100%; background-color: #40444b; color: white; border: 1px solid #555;"></textarea></div>
                            <button id="burner-save-settings" style="width: 100%; padding: 10px; background-color: #4caf50; color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 15px;">設定を保存</button>
                        </div>
                    </div>
                    <div id="chasm-burner-log-container" style="margin-top: 15px; padding: 10px; border: 1px solid #444; background-color: #1e1f22; height: 120px; overflow-y: auto; font-family: monospace; font-size: 12px; border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; font-weight: bold; margin-bottom: 5px; border-bottom: 1px solid #444; padding-bottom: 5px;">
                           <span>実行ログ: <span id="chasm-burner-status">待機中</span></span>
                           <span id="chasm-burner-timer" style="font-family: monospace;">00:00</span>
                        </div>
                        <div id="chasm-burner-log"></div>
                    </div>
                </div>
            </div>`;
        const styleHTML = `
            .tab-btn { background: none; border: none; padding: 10px 15px; cursor: pointer; color: #ccc; }
            .tab-btn.active { border-bottom: 2px solid #5865f2; font-weight: bold; color: white; }
            .setting-item { margin-bottom: 10px; }
            .setting-item label { display: block; margin-bottom: 5px; font-size: 14px; }
            #execute-btn:disabled, button[id^="copy-summary-"]:disabled { background-color: #28327c; cursor: not-allowed; }
        `;
        document.head.insertAdjacentHTML('beforeend', `<style>${styleHTML}</style>`);
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        document.querySelectorAll('.tab-btn').forEach(attachTabListener);

        const settings = new S();
        document.querySelector("#burner-close-btn").addEventListener("click", () => document.querySelector("#chasm-burner-modal").style.display = 'none');

        document.querySelector("#execute-btn").addEventListener("click", () => {
            const selectedPromptId = document.querySelector("#prompt-select").value;
            const promptText = document.querySelector(`#prompt-${selectedPromptId}`).value;
            w(promptText);
        });

        const promptSelect = document.querySelector("#prompt-select");
        promptSelect.addEventListener('change', (e) => {
            document.querySelectorAll('.prompt-text').forEach(area => area.style.display = 'none');
            document.querySelector(`#prompt-${e.target.value}`).style.display = 'block';
        });

        document.querySelector("#burner-gemini-model-select").addEventListener('change', (e) => {
            const isDirectInput = e.target.value === 'direct-input';
            document.querySelector("#custom-gemini-model-div").style.display = isDirectInput ? 'block' : 'none';
        });

        document.querySelector("#burner-api-provider").addEventListener("change", (e) => {
            const isGemini = e.target.value === "gemini";
            document.querySelector("#gemini-settings").style.display = isGemini ? "block" : "none";
            document.querySelector("#openrouter-settings").style.display = isGemini ? "none" : "block";
        });

        document.querySelector("#burner-save-settings").addEventListener("click", async () => {
            f.geminiAPIKey = document.querySelector("#burner-gemini-key").value;
            f.openrouterAPIKey = document.querySelector("#burner-openrouter-key").value;
            f.apiProvider = document.querySelector("#burner-api-provider").value;
            f.geminiModel = document.querySelector("#burner-gemini-model-select").value;
            f.customGeminiModel = document.querySelector("#burner-custom-gemini-model").value;
            f.openrouterModel = document.querySelector("#burner-openrouter-model").value;
            f.messageLimit = parseInt(document.querySelector("#burner-message-limit").value, 10);
            f.prependText = document.querySelector("#burner-prepend-text").value;
            f.appendText = document.querySelector("#burner-append-text").value;
            f.activePromptId = document.querySelector("#prompt-select").value;
            const activePromptTextEl = document.querySelector(`#prompt-${f.activePromptId}`);
            if (activePromptTextEl && f.activePromptId === 'custom') {
                await GM_setValue('customPromptText', activePromptTextEl.value);
            }
            await settings.saveSettings();
            alert("設定が保存されました。");
        });
    }

    async function I() {
        const target = document.querySelector(`.${buttonTargetClass}`);
        if (target && !document.querySelector("#chasm-burner-launch-btn")) {
            const btn = document.createElement("button");
            btn.id = "chasm-burner-launch-btn";
            btn.innerHTML = `🔥 キャラぷ<br>キャズムバーナー 実行`;
            btn.style.cssText = `width: 100%; height: 52px; padding: 6px 15px; margin-bottom: 8px; background-color: #5865f2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; order: -1; text-align: center; line-height: 1.3;`;
            btn.onclick = async () => {
                const settings = new S();
                await settings.loadSettings();

                document.querySelector("#burner-gemini-key").value = f.geminiAPIKey;
                document.querySelector("#burner-openrouter-key").value = f.openrouterAPIKey;
                document.querySelector("#burner-api-provider").value = f.apiProvider;
                document.querySelector("#burner-gemini-model-select").value = f.geminiModel;
                document.querySelector("#burner-custom-gemini-model").value = f.customGeminiModel;
                document.querySelector("#burner-openrouter-model").value = f.openrouterModel;
                document.querySelector("#burner-message-limit").value = f.messageLimit;
                document.querySelector("#burner-prepend-text").value = f.prependText;
                document.querySelector("#burner-append-text").value = f.appendText;

                const promptSelect = document.querySelector("#prompt-select");
                promptSelect.value = f.activePromptId;

                const customPromptText = await GM_getValue('customPromptText', '会話内容を要約してください。');
                const customPromptEl = document.querySelector('#prompt-custom');
                if(customPromptEl) customPromptEl.value = customPromptText;

                promptSelect.dispatchEvent(new Event('change'));
                document.querySelector("#burner-gemini-model-select").dispatchEvent(new Event('change'));
                document.querySelector("#burner-api-provider").dispatchEvent(new Event('change'));
                document.querySelector("#chasm-burner-modal").style.display = 'flex';
            };
            target.prepend(btn);
        }
    }

    C();
    const M = new MutationObserver(c(I, 500));
    M.observe(document.body, { childList: true, subtree: true });
})();
