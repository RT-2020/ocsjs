/**
 * 慕享答题工作器（workAndExam）+ 答题页等待（waitForQuestion）。
 *
 * 从 moycp.ts 拆分而来（纯搬运，零逻辑变更）。
 * 包含：答题器构造、选项匹配、逐题答题循环、提交、结算页解析、答案缓存、闯关失败重闯。
 * 依赖 moycp-shared 的共享工具，不反向依赖 moycp.ts（避免循环）。
 */
import { $, OCSWorker, defaultAnswerWrapperHandler } from '@ocsjs/core';
import { $store } from 'easy-us';
import { CommonWorkOptions } from '../utils';
import { CommonProject } from './common';
import { optimizationElementWithImage, removeRedundantWords, simplifyWorkResult } from '../utils/work';
import { $console, BackgroundProject } from './background';
import { $msg_and_log, $dbg, humanSleep } from './moycp-shared';

export function waitForQuestion() {
	return new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			// 慕享答题页题目根容器
			if (document.querySelector('.answer-panel-container')) {
				clearInterval(interval);
				resolve();
			}
		}, 1000);
	});
}

/**
 * 慕享答题工作器
 *
 * 慕享答题为单题逐题展示：每次屏幕只显示一题，
 * root 选择器指向单题容器即可，OCSWorker 会逐个处理当前可见题目。
 *
 * ⚠️ 慕享是 Vue 应用，选项的 .click() 会被框架拦截而失效，
 *    必须用 `input.checked = true; dispatchEvent('change')` 触发 Vue 响应。
 *    选中后慕享不会自动跳题，需由外层 while 循环点击 .btn.next 翻页。
 */
export function workAndExam(
	{ answererWrappers, redundanceWordsText, upload, stopSecondWhenFinish, answerSeparators }: CommonWorkOptions
) {
	// 🔍 缓存诊断收集器：写入 localStorage（不被慕享 console.clear 清除），事后用 evaluate 读取
	const _diagKey = 'moycp_cache_diag';
	const _diag = (msg: string) => {
		try {
			const arr = JSON.parse(localStorage.getItem(_diagKey) || '[]');
			arr.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
			localStorage.setItem(_diagKey, JSON.stringify(arr.slice(-50)));
		} catch { /* ignore */ }
	};
	try { localStorage.setItem(_diagKey, '[]'); } catch { /* reset */ }

	CommonProject.scripts.workResults.methods.init({
		questionPositionSyncHandlerType: 'moycp'
	});

	/** 题目文本转换：移除冗余词、压缩空白 */
	const titleTransform = (titles: (HTMLElement | undefined)[]) => {
		return removeRedundantWords(
			titles
				.filter((t) => t?.innerText || t?.querySelector('img'))
				.map((t) => {
					if (t) {
						const el = optimizationElementWithImage(t, true);
						return (el.textContent || '').replace(/\s+/g, ' ').trim() || '';
					}
					return '';
				})
				.filter((t) => t.trim() !== '')
				.join(','),
			redundanceWordsText.split('\n')
		);
	};

	/**
	 * 解析结算页的正确答案。
	 *
	 * 提交后慕享展示结算页，结构（MCP 实测确认，2026-06）：
	 *   dl.question-list（每题一个）：
	 *     div.question-num("第N题")
	 *     dt > div.singleflag span(题型:多选题/单选题/判断题) + div.question-title p(题干)
	 *     div > dd.answer-option label（每选项一个）
	 *              input[radio|checkbox] + p.answer-item("A. <span>选项文字</span>")
	 *     div.right-answer（"正确答案 : <span>A</span>"，多选如 "A C D"）
	 *       ⚠️ right-answer 在结算页 DOM 动态变化时位置不稳，需容错：dl 内找不到时按题号全局兜底
	 *
	 * 关键改进（修复选项顺序错乱）：
	 *   原实现直接缓存字母（"A"），但慕享下次会打乱选项顺序，"A" 对应的选项文本变化 → 按 A 选会选错。
	 *   现改为：用「字母→选项文字」映射，把正确答案转成选项文本存储。
	 *   重答时按文本匹配选项（CustomWork 已支持文本匹配），不受顺序影响。
	 *
	 * 同时记录题型（type），写入缓存时按 title+type 区分，避免同一题干在不同题型下答案冲突。
	 */
	const parseResultPageAnswers = (): { title: string; answer: string; type?: string }[] => {
		const dls = document.querySelectorAll('dl.question-list');
		const results: { title: string; answer: string; type?: string }[] = [];
		dls.forEach((dl, idx) => {
			const titleEl = dl.querySelector<HTMLElement>('.question-title');
			if (!titleEl) return;
			const title = titleTransform([titleEl]);

			// 题型：div.singleflag span（文本如"多选题/单选题/判断题"）
			const typeRaw = dl.querySelector('.singleflag span')?.textContent?.trim() || undefined;
			// 归一化题型标识，与 ctx.type（core 框架）对齐：
			//   单选→single 多选→multiple 判断→judgement 填空→completion，其它原样保留
			const type = typeRaw
				? /多选/.test(typeRaw)
					? 'multiple'
					: /单选/.test(typeRaw)
					? 'single'
					: /判断/.test(typeRaw)
					? 'judgement'
					: /填空/.test(typeRaw)
					? 'completion'
					: typeRaw
				: undefined;

			// 构造「字母→选项文本」映射。选项格式："A. <span>选项文字</span>"
			// ⚠️ 结算页与答题页的选项容器 class 不同（MCP 实测确认，2026-06）：
			//   答题页：dd.answer-option > label > p.answer-item
			//   结算页：dd(class 为空!) > label > p.answer-item
			//   旧代码用 dl.querySelectorAll('dd.answer-option') 选选项，结算页 dd 无此 class
			//   → 选不到选项 → letterToText 为空 → 退化为存字母（"缓存存选项"bug 根因）。
			//   修复：直接选 p.answer-item（两页都有此 class，不受 dd 的 class 影响）。
			const letterToText = new Map<string, string>();
			dl.querySelectorAll('p.answer-item').forEach((p) => {
				const itemText = p.textContent?.replace(/\s+/g, ' ').trim() || '';
				// 提取首字母 + 去掉 "A. " 前缀后的选项正文
				const m = itemText.match(/^([A-Z])[.、)\s]+(.+)$/);
				if (m) {
					letterToText.set(m[1], m[2].trim());
				}
			});

			// 正确答案字母（dl 内找，找不到则按题号全局兜底）
			let answerEl = dl.querySelector('.right-answer span');
			if (!answerEl) {
				const allRightAnswers = document.querySelectorAll('.right-answer span');
				answerEl = allRightAnswers[idx] || null;
			}
			if (!answerEl) return;

			// 答案字母：多选如 "A C D" → ["A","C","D"]，单选/判断如 "A"
			const letters = (answerEl.textContent || '').replace(/\s+/g, '').trim().split('');
			if (letters.length === 0) return;

			// 映射成选项文本：能映射则用文本（顺序无关），映射失败退化为字母（填空题等无选项的情况）
			const mapped = letters
				.map((L) => letterToText.get(L))
				.filter((t): t is string => !!t);
			const answer = mapped.length === letters.length ? mapped.join('#') : letters.join('');

			if (title && answer) {
				results.push({ title, answer, type });
				$dbg(`结算页答案: [${typeRaw || '?'}] ${title.slice(0, 18)}... => ${answer}`);
			}
		});
		return results;
	};

	/**
	 * 把结算页正确答案写入题库缓存。
	 *
	 * 直接调用底层 addQuestionCache（带 type），绕过 SWR 中间层——
	 * 结算页 type 维度是 moycp 特有需求，不该强加到通用 SWR 路径（Gate A：归属正确）。
	 * addQuestionCache 的去重逻辑会按 title+type 覆盖旧答案（只保留最新正确答案）。
	 */
	const saveCorrectAnswersToCache = (answers: { title: string; answer: string; type?: string }[]) => {
		if (!answers.length) {
			$dbg('结算页未提取到答案，跳过缓存');
			_diag('写入缓存: 0题（结算页未提取到答案）');
			return;
		}
		// 用内联结构类型，无需导入 core 的 QuestionCache（结构兼容即可）
		const items = answers.map((a) => ({
			title: a.title,
			answer: a.answer,
			from: '闯关结算页',
			homepage: '',
			ai: false,
			type: a.type
		}));
		// 🔍 诊断：输出每条缓存的 title/answer/type
		_diag('写入缓存 ' + items.length + '题: ' + items.map(i => `[${i.title.slice(0,12)}=>${i.answer.slice(0,15)}]`).join(' '));
		CommonProject.scripts.apps.methods.addQuestionCache(...items);
		$dbg(`已记录 ${answers.length} 题的正确答案到题库缓存（含题型区分）`);
	};

	/** 检测结算页是否闯关失败（body 含"任务失败"） */
	const isExamFailed = (): boolean => {
		return document.body.innerText.includes('任务失败');
	};

	/** 重闯当前小节：用当前 type=exam URL 重新导航，触发 work 用缓存答案重答。
	 * ⚠️ 重闯计数用 $store 持久化——retryCurrentExam 用 location.href 整页刷新，
	 * 模块级 state 会重置，导致计数每次从 0 开始、上限永远到不了。
	 * 用 $store（GM 持久存储）按 itemId 存计数，跨刷新保留。
	 */
	const getRetryKey = (itemId: string) => `moycp_exam_retry_${itemId}`;
	const getRetryCount = (itemId: string) => parseInt($store.get(getRetryKey(itemId), '0') || '0', 10);
	const setRetryCount = (itemId: string, n: number) => $store.set(getRetryKey(itemId), String(n));
	const clearRetryCount = (itemId: string) => {
		try {
			$store.delete(getRetryKey(itemId));
		} catch {
			/* 某些环境 delete 不可用，忽略 */
		}
	};
	const retryCurrentExam = () => {
		const itemId = new URLSearchParams(location.search).get('itemId') || '';
		const count = getRetryCount(itemId) + 1;
		setRetryCount(itemId, count);
		const MAX_RETRY = 2;
		if (count > MAX_RETRY) {
			$msg_and_log('warn', `闯关失败且重闯已达上限（${MAX_RETRY}次），跳过当前小节，请手动检查。`);
			clearRetryCount(itemId);
			return false;
		}
		$msg_and_log('info', `检测到闯关失败，使用记录的正确答案重闯当前小节（第 ${count} 次）`);
		// 重新进入当前答题页（带随机延迟，模拟人工）
		setTimeout(() => {
			// 重新导航回答题页，dispatcher/oncomplete 会重新触发 work.main（防重入锁已释放）
			location.href = location.pathname + location.search;
		}, 800 + Math.floor(Math.random() * 1200));
		return true;
	};

	/**
	 * 从题库/AI 搜题（answerer 的 whenSearchEmpty 逻辑抽出，供 work 兜底复用）。
	 *
	 * 搜题策略：先并行跑所有非 AI 题库 wrapper → 有结果就用；
	 * 否则顺序尝试每个 AI wrapper（主→备用），第一个返回非空答案就用。
	 *
	 * @returns SearchInformation[]（可能为空）
	 */
	const searchFromSources = async (
		title: string,
		optionText: string,
		type: string | undefined
	): Promise<ReturnType<typeof defaultAnswerWrapperHandler>> => {
		const nonAIWrappers = answererWrappers.filter((w) => !w.name.includes('AI大模型题库'));
		const aiWrappers = answererWrappers.filter((w) => w.name.includes('AI大模型题库'));
		// 先并行跑所有非 AI wrapper（题库类，无 key 限制）
		const nonAIResults =
			nonAIWrappers.length > 0
				? await defaultAnswerWrapperHandler(nonAIWrappers, {
						type: type || 'unknown',
						title,
						options: optionText
				  })
				: [];
		if (nonAIResults.some((r) => r.results && r.results.length > 0)) {
			return nonAIResults;
		}
		// 顺序尝试每个 AI wrapper（主→备用），第一个有答案就用
		for (let i = 0; i < aiWrappers.length; i++) {
			const aw = aiWrappers[i];
			try {
				$dbg(`搜题: 尝试 ${aw.name} (${i + 1}/${aiWrappers.length})`);
				const results = await defaultAnswerWrapperHandler([aw], {
					type: type || 'unknown',
					title,
					options: optionText
				});
				if (results.some((r) => r.results && r.results.length > 0)) {
					$dbg(`搜题: ${aw.name} 命中`);
					return results;
				}
			} catch (e) {
				$dbg(`搜题: ${aw.name} 出错，切换下一个`);
			}
		}
		return nonAIResults;
	};

	/**
	 * 把答案匹配到选项并选中（work 的核心匹配逻辑抽出，供兜底重试复用）。
	 *
	 * 匹配规则（沿用原 work 逻辑）：
	 * 1. 字母匹配：token 是 A/B/C/D，选项以 "A."/"A、"/"A)" 开头
	 * 2. 判断题：token 是 正确/错误，选项文本含正确/错误
	 * 3. 文本包含匹配（去掉字母前缀后双向比较）——支持选项文本格式的缓存答案
	 *
	 * @returns 匹配并选中的数量（0 表示没匹配上）
	 */
	const matchAnswersToOptions = async (answers: string[], options: HTMLElement[]): Promise<number> => {
		if (answers.length === 0) return 0;
		// 拆分所有答案为单个 token
		const tokens = new Set<string>();
		for (const ans of answers) {
			for (const part of ans.split(/[#\s,，、；;]+/).filter(Boolean)) {
				tokens.add(part.trim());
			}
			// 纯字母答案（如 "AC"）拆成单个字母
			if (/^[A-Da-d]{1,4}$/.test(ans.trim())) {
				for (const ch of ans.trim()) tokens.add(ch.toUpperCase());
			}
		}

		// 先计算所有应选选项，再批量点击（抢在慕享自动跳转前选完）
		const toSelect: { opt: HTMLElement; optText: string }[] = [];
		for (const opt of options) {
			const input = opt.querySelector('input') as HTMLInputElement | null;
			if (!input || input.checked) continue;
			const optText = opt.innerText.replace(/\s+/g, '').trim();
			let shouldSelect = false;
			for (const token of tokens) {
				const t = token.replace(/\s+/g, '');
				if (/^[A-D]$/.test(t)) {
					if (new RegExp('^' + t + '[.、)]').test(optText)) {
						shouldSelect = true;
						break;
					}
				}
				if (t === '正确' || t === '对' || t === '是') {
					if (optText.includes('正确') || optText.includes('对')) {
						shouldSelect = true;
						break;
					}
				}
				if (t === '错误' || t === '错' || t === '否') {
					if (optText.includes('错误') || optText.includes('错')) {
						shouldSelect = true;
						break;
					}
				}
				const optNoPrefix = optText.replace(/^[A-D][.、)]/, '');
				if (optNoPrefix.includes(t) || t.includes(optNoPrefix)) {
					shouldSelect = true;
					break;
				}
			}
			if (shouldSelect) toSelect.push({ opt, optText });
		}

		// 逐个 label.click() 选中，带随机延迟（触发 Vue 选中状态）
		let matchedCount = 0;
		for (const { opt, optText } of toSelect) {
			if (matchedCount > 0) await humanSleep(150, 350);
			const label = opt.closest('label') || opt.querySelector('label') || opt;
			label.click();
			matchedCount++;
			console.log('[OCS-CustomWork] 选中: ' + optText.slice(0, 20));
		}
		return matchedCount;
	};

	/** 新建答题器 */
	const worker = new OCSWorker({
		/**
		 * 慕享答题页为单题模式，root 指向当前题目容器。
		 * .answer-panel-content 内每次渲染一题。
		 */
		root: '.answer-panel-content',
		elements: {
			/** 题干： .question-title 下的文本 */
			title: '.question-title',
			/**
			 * 选项：每个 dd.answer-option > label 包含 input + p.answer-item
			 * 选项 value 后缀序号被打乱（非 ABCD 顺序），必须按文本匹配答案
			 */
			options: 'dd.answer-option label'
		},
		thread: 1,
		answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
		/**
		 * 搜题方法构造器 —— 全流程「答案来源」的唯一入口。
		 *
		 * 取答案顺序（严格缓存优先，未命中才走题库）：
		 *   1. searchAnswerInCaches(title, type)：命中本地题库缓存（结算页写入的正确答案）→ 直接返回
		 *   2. 缓存未命中 → searchFromSources：题库（并行）→ 仍无结果 → AI 大模型（顺序主→备）
		 *
		 * ⚠️ work（自定义处理器）不再做任何搜题，只把本方法拿到的答案匹配到选项上。
		 *    历史 bug：旧 work 里另起两处 searchFromSources 兜底搜题，与这里输入完全相同、
		 *    结果必然一致，纯属重复调用 —— 既看不出"缓存优先"，也从未真正救回过缓存命中但
		 *    匹配不上的题（搜题是确定性的，二次搜还是同一个答案）。故移除，统一由 answerer 负责。
		 *
		 * ⚠️ 显式设置题型（MCP 实测确认，2026-06）：
		 *   moycp 的 work 是函数形式（自定义处理器），框架不会调 type resolver，
		 *   ctx.type 恒为 undefined。这导致 AI 搜题不知题型（多选可能给单选答案→答错），
		 *   且缓存 type 维度不一致。这里在搜题前手动从 DOM 读题型赋值给 ctx.type。
		 */
		answerer: (elements, ctx) => {
			const typeRaw =
				document.querySelector('.answer-panel-content .singleflag span')?.textContent?.trim() || '';
			if (/多选/.test(typeRaw)) ctx.type = 'multiple';
			else if (/单选/.test(typeRaw)) ctx.type = 'single';
			else if (/判断/.test(typeRaw)) ctx.type = 'judgement';
			else if (/填空/.test(typeRaw)) ctx.type = 'completion';

			const title = titleTransform(elements.title);
			if (title) {
				// 第三参数 ctx.type：按 title+type 精确匹配缓存，避免同一题干在不同题型下答案冲突
				// 🔍 缓存命中诊断：在 searchAnswerInCaches 外面包一层，把「命中/未命中 + 原因」
				//    打到面板（$dbg），方便定位"触发答题不从缓存读"到底为何。
				//    命中判断依据 extra_data.cache=true（searchAnswerInCaches 命中时打的标记）。
				const cacheEnabled = CommonProject.scripts.settings.cfg.enableQuestionCaches !== false;
				const cacheSize = CommonProject.scripts.apps.cfg.localQuestionCaches?.length || 0;
				return CommonProject.scripts.apps.methods.searchAnswerInCaches(
					title,
					async () => {
						// 走到这里 = 缓存未命中（或缓存功能关闭）。给出明确未命中原因，便于排查。
						if (!cacheEnabled) {
							$dbg(`缓存未命中（功能已关闭）→ 走题库/AI: ${title.slice(0, 20)} | type=${ctx.type}`);
						} else if (cacheSize === 0) {
							$dbg(`缓存为空（首次闯关，结算页提交后才写入缓存）→ 走题库/AI: ${title.slice(0, 20)} | type=${ctx.type}`);
						} else {
							// 缓存非空却没命中：title 或 type 不匹配。把首条缓存 title/type 也打出来对照。
							const sample = CommonProject.scripts.apps.cfg.localQuestionCaches[0];
							$dbg(
								`缓存未命中（有 ${cacheSize} 条但 title/type 不匹配）→ 走题库/AI: ` +
									`${title.slice(0, 20)} | type=${ctx.type} | 样例缓存 title=${(sample.title || '').slice(0, 20)} type=${sample.type}`
							);
						}
						const optionText = ctx.elements.options
							.map((o) => optimizationElementWithImage(o, true).innerText)
							.join('\n');
						return searchFromSources(title, optionText, ctx.type);
					},
					ctx.type
				).then((infos) => {
					const fromCache = infos.some((i) => i.results.some((r) => (r as any).extra_data?.cache));
					$dbg(
						`查询完成: ${title.slice(0, 20)} | 命中缓存=${fromCache} | 答案数=${infos.reduce((n, i) => n + i.results.length, 0)}`
					);
					return infos;
				});
			} else {
				throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
			}
		},
		/**
		 * 自定义工作器 —— 纯「答案 → 选项」匹配器，不做任何搜题。
		 *
		 * 答案来源完全交给上方 answerer（缓存优先 → 题库 → AI）。work 只负责把 ctx.searchInfos
		 * 里已有的答案，按题型落到页面上：
		 *   - 填空题：把答案写进输入框
		 *   - 单选/多选/判断题：调 matchAnswersToOptions 把答案匹配到选项并选中
		 * 无答案或一个选项都匹配不上时返回 finish=false（由外层答题循环在下一轮再试）。
		 */
		work: async (ctx) => {
			const options = ctx.elements.options;
			const type = ctx.type;

			/** 从 ctx.searchInfos 汇总答案为字符串数组 */
			const collectAnswers = (infos: typeof ctx.searchInfos) =>
				infos
					.map((info) => info.results.map((r) => r.answer))
					.flat()
					.filter(Boolean) as string[];

			const answers = collectAnswers(ctx.searchInfos);
			$dbg(`答题: 题型=${type} 选项数=${options.length} 答案=${JSON.stringify(answers)}`);

			// answerer 已返回空 → 确实无答案（缓存未命中且题库/AI 都没搜到），跳过本题
			if (answers.length === 0) {
				$dbg('答题: 无答案，跳过');
				return { finish: false };
			}

			// 填空题：找输入框填入答案
			if (type === 'completion') {
				const answer = answers[0].trim();
				await humanSleep(800, 1600);
				for (const opt of options) {
					const input = opt.querySelector('textarea, input[type=text]') as HTMLInputElement | null;
					if (input && input.value.trim() !== answer) {
						input.value = answer;
						input.dispatchEvent(new Event('input', { bubbles: true }));
						input.dispatchEvent(new Event('change', { bubbles: true }));
						return { finish: true };
					}
				}
				return { finish: false };
			}

			// 单选/多选/判断题：把答案匹配到选项并选中
			const matchedCount = await matchAnswersToOptions(answers, options);
			$dbg(`答题: 完成匹配，共选中 ${matchedCount} 个`);
			return { finish: matchedCount > 0 };
		},
		onElementSearched(elements) {
			elements.options.forEach((el) => {
				optimizationElementWithImage(el);
			});
		},
		/** 完成答题后 */
		onResultsUpdate(curr, _, res) {
			CommonProject.scripts.workResults.methods.setResults(simplifyWorkResult(res, titleTransform));

			// ⚠️ 不在答题时缓存答案（MCP 实测 + 用户反馈确认，2026-06）。
			//
			// 历史问题：旧代码在此调用 addQuestionCacheFromWorkResult，把答题时的搜题结果
			// （含 AI 答案）直接写入缓存。但"匹配到选项"(finish=true) ≠ "答案正确"——AI 可能
			// 答错，照样被缓存。错误答案按 title+type 去重覆盖后，下次命中缓存直接用错误答案 →
			// 反复答错 → 星级上不去 → 卡在同一章节死循环。
			//
			// 修复：答题时不缓存，只在【结算页】缓存慕享给出的正确答案（saveCorrectAnswersToCache）。
			//   - 结算页答案是权威的（慕享标注的 right-answer），且已转成选项文本存储；
			//   - 下次命中缓存用文本匹配选项（matchAnswersToOptions 支持），不受选项顺序打乱影响；
			//   - 这样保证缓存里只有正确答案，AI 答错的题不会污染缓存。
			//
			// ⚠️ 不调用 updateWorkStateByResults(res)：单题模式下 res.length 恒为 1，
			//    会把 totalQuestionCount 覆盖成 1（导致 UI 显示 1/1）。
			//    总题数和进度由答题循环里的 updateWorkState 手动维护（见下方循环）。
		}
	});

	/**
	 * 逐题答题循环
	 *
	 * 慕享为单题逐题模式，屏幕一次只显示一道题。
	 * 流程：答当前题 → 等待 → 点下一题 → 等新题加载 → 循环，直到没有下一题。
	 *
	 * 关键点：
	 * 1. 「下一题」按钮 .btn.next 在当前题未作答时会带 .noClick 类（点击无效）。
	 *    常见于题库无答案、无法匹配选项的情况，此时通过答题卡跳转到下一题号。
	 * 2. Vue 元素需用 .click() + MouseEvent 触发。
	 */
	/** 触发 Vue 元素的点击 */
	const clickVue = (el: HTMLElement) => {
		el.click();
		el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};
	/**
	 * 判断答题是否应停止。
	 * worker.isClose：重新答题/关闭时为 true（来自 'close' 事件）
	 * worker.isStop：点「暂停」按钮时为 true（来自 'stop' 事件）
	 * ⚠️ 必须同时检查两者——旧代码只检查 isClose，导致点暂停（isStop）后循环不停。
	 */
	const isStopped = () => worker.isClose || worker.isStop;
	/** 通过答题卡跳转到指定题号 span（按 DOM 顺序，0 = 第1题）*/
	const gotoQuestion = (index: number) => {
		const span = document.querySelectorAll<HTMLElement>('.select-item-list span').item(index);
		if (span) {
			clickVue(span);
			return true;
		}
		return false;
	};

	let lastQuestionTitle = '';
	let sameTitleCount = 0;
	let totalAnswered = 0;

	/** 获取当前题号（从答题卡 .current 读取，0-based） */
	const getCurrentIdx = () => {
		const spans = document.querySelectorAll('.select-item-list span');
		const cur = document.querySelector('.select-item-list span.current');
		return cur ? Array.from(spans).indexOf(cur) : 0;
	};
	/** 获取总题数 */
	const getTotalCount = () => document.querySelectorAll('.select-item-list span').length;
	/** 判断指定题号是否已答（答题卡 span 含 .already 类）*/
	const isAnswered = (idx: number) => {
		const spans = document.querySelectorAll('.select-item-list span');
		return !!spans[idx]?.classList.contains('already');
	};
	/** 获取所有未答题的 index 列表 */
	const getUnansweredIndices = () => {
		const spans = document.querySelectorAll('.select-item-list span');
		const result: number[] = [];
		spans.forEach((s, i) => {
			if (!s.classList.contains('already')) result.push(i);
		});
		return result;
	};
	/**
	 * 强制翻到指定题号，并等待 DOM 真正切换完成。
	 * 慕享选中选项后会自动跳走，这里负责把它"拉回"到目标题。
	 */
	const forceGoto = async (targetIdx: number) => {
		if (getCurrentIdx() === targetIdx) return;
		gotoQuestion(targetIdx);
		for (let w = 0; w < 5000; w += 300) {
			await $.sleep(300);
			if (getCurrentIdx() === targetIdx) break;
		}
		// 翻页后随机停顿，模拟人工阅读题目的节奏
		await humanSleep(600, 1200);
	};
	/**
	 * 答单道题：强制翻到 targetIdx → doWork → 等待并验证是否真正作答成功。
	 * 返回是否作答成功（答题卡该题变为 already）。
	 */
	const answerOne = async (targetIdx: number): Promise<boolean> => {
		await forceGoto(targetIdx);
		if (isStopped()) return false;

		const wasAnswered = isAnswered(targetIdx);
		await worker.doWork({
			enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug
		});

		// 多选题/判断题的「确定」按钮（MCP 实测确认，2026-06）：
		//
		// ⚠️ 历史问题：多选题选完选项后，慕享不会立即把答题卡标记为 .already，
		//   而是需要先点「确定」(div.btn.pre.confirm-answer) 提交本题，选项才被确认。
		//   旧代码选完只等 .already，多选题因没点确定 → 永远等不到 already →
		//   判定"未作答成功" → 整个答题流程卡住、无法进入下一题/完成。
		//   （单选题选中即生效，没有此按钮，下面 findConfirmAnswerBtn 返回 null 跳过。）
		//
		// 修复：选完选项后，若出现「确定」按钮且可点（不带 noClick 禁用态），就自动点掉，
		//      让多选题的选项被提交，答题卡才会标记 .already。
		const findConfirmAnswerBtn = (): HTMLElement | null => {
			const btn = document.querySelector<HTMLElement>('.btn.pre.confirm-answer');
			if (!btn) return null;
			// 选项未选完时按钮会带 noClick 禁用态（与 .btn.next 同机制），此时不可点
			if (btn.classList.contains('noClick') || btn.hasAttribute('disabled')) return null;
			return btn;
		};
		// 最多等 3 秒，等「确定」按钮出现且可点（选项选完后才会启用）
		let confirmBtn: HTMLElement | null = null;
		for (let w = 0; w < 3000; w += 300) {
			if (isStopped()) break;
			confirmBtn = findConfirmAnswerBtn();
			if (confirmBtn) break;
			await $.sleep(300);
		}
		if (confirmBtn) {
			$dbg(`流程: 第 ${targetIdx + 1} 题检测到多选题「确定」按钮，自动点击提交`);
			clickVue(confirmBtn);
		}

		// 等待慕享标记为已答（选中/点确定后慕享异步更新 .already，最多等 4 秒）
		for (let w = 0; w < 4000; w += 400) {
			await $.sleep(400);
			if (isAnswered(targetIdx)) break;
		}

		const nowAnswered = isAnswered(targetIdx);
		// 如果之前未答现在也未答，说明没作答成功（如AI无答案）
		if (!wasAnswered && !nowAnswered) {
			$msg_and_log('warn', `第 ${targetIdx + 1} 题未作答成功（可能题库无答案）。`);
		}
		return nowAnswered;
	};

	(async () => {
		/**
		 * 慕享答题策略（强制顺序 + 循环补漏）：
		 *
		 * 1. 第一轮：按 0,1,2,...,N 顺序逐题作答
		 * 2. 每轮结束后扫描未答题，如果有则再答一轮（最多 3 轮，防止死循环）
		 * 3. 连续两轮未答题数无变化则停止（剩余的都是无答案的题）
		 */
		// 等答题卡渲染完成（进入答题页时 Vue 异步渲染，立即读会得到 1/0）
		for (let w = 0; w < 10000; w += 500) {
			await $.sleep(500);
			if (getTotalCount() > 1) break;
			if (isStopped()) return;
		}
		const total = getTotalCount();
		// 更新 UI 题数（单题模式下 doWork 每次 results.length=1，必须手动用实际总题数，
		// 否则 UI 永远显示 1/1）
		CommonProject.scripts.workResults.methods.updateWorkState({
			totalQuestionCount: total,
			requestedCount: 0,
			resolvedCount: 0
		});
		await $.sleep(1500);
		$msg_and_log('info', `开始答题（共 ${total} 题，顺序遍历+补漏）。`);

		const MAX_ROUNDS = 3;
		let prevUnansweredCount = -1;

		for (let round = 1; round <= MAX_ROUNDS; round++) {
			if (isStopped()) break;

			const unanswered = getUnansweredIndices();
			if (unanswered.length === 0) {
				$msg_and_log('info', `第 ${round - 1} 轮后，所有题目均已作答。`);
				break;
			}

			// 连续两轮未答题数相同，说明剩余的都是无答案的题，停止
			if (unanswered.length === prevUnansweredCount) {
				$msg_and_log('warn', `连续两轮仍有 ${unanswered.length} 题未答，可能无答案，停止答题。未答题号：${unanswered.map((i) => i + 1).join(', ')}`);
				break;
			}
			prevUnansweredCount = unanswered.length;

			$msg_and_log('info', `第 ${round} 轮答题开始，待答 ${unanswered.length} 题：${unanswered.map((i) => i + 1).join(', ')}`);

			for (const targetIdx of unanswered) {
				if (isStopped()) break;
				const ok = await answerOne(targetIdx);
				totalAnswered++;
				// 更新 UI 进度（已解决题数 = 当前已答数）
				const answeredNow = getUnansweredIndices();
				CommonProject.scripts.workResults.methods.updateWorkState({
					totalQuestionCount: total,
					requestedCount: total - answeredNow.length,
					resolvedCount: total - answeredNow.length
				});
				// 答完一题后随机停顿，模拟人工节奏（等慕享自动跳转稳定）
				await humanSleep(1000, 2000);
			}
		}

		if (isStopped()) {
			return;
		}

		$msg_and_log('info', `全部题目答题完成（共处理 ${totalAnswered} 次），等待 ${stopSecondWhenFinish} 秒后提交。`);
		await $.sleep(stopSecondWhenFinish * 1000);
		if (isStopped()) {
			return;
		}

		// 处理提交
		const results = await worker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug });
		// 诊断日志：记录提交前的关键状态，定位"提示提交但没提交"的问题
		{
			const unansweredBefore = getUnansweredIndices();
			const finishedCount = results.filter((r) => r.result?.finish).length;
			console.log('[OCS-moycp] 提交前状态: upload配置=', upload,
				'| doWork题数=', results.length,
				'| finish题数=', finishedCount,
				'| 计算完成率=', results.length === 0 ? 0 : (finishedCount / results.length) * 100,
				'| 答题卡未答数=', unansweredBefore.length,
				'| 答题卡总数=', getTotalCount());
		}
		await worker.uploadHandler({
			type: upload,
			results,
			async callback(finishedRate, uploadable) {
				// ⚠️ 关键：框架的 uploadable 基于 doWork 单题的 finish 状态算完成率，
				// 但 moycp 是单题模式（results.length 恒为1），若提交前那道题没答上，
				// uploadable=false 就不会提交——即使其他题都答了。
				// 用答题卡的真实未答数覆盖判定：只要所有题都答了就提交。
				const realUnanswered = getUnansweredIndices();
				const realUploadable = uploadable || realUnanswered.length === 0;
				console.log('[OCS-moycp] uploadHandler: 框架完成率=', finishedRate.toFixed(2),
					'| 框架uploadable=', uploadable,
					'| 答题卡未答=', realUnanswered.length,
					'| 最终是否提交=', realUploadable);
				const content = `完成率 ${finishedRate.toFixed(2)}% : ${realUploadable ? '3秒后将自动提交' : '3秒后将自动跳过'}`;
				$console.info(content);
				$msg_and_log('info', content);

				await $.sleep(3000);
				if (isStopped()) {
					return;
				}
				if (realUploadable) {
					// practice 模式（type=practice）跳过统一提交（MCP 实测确认，2026-06）：
					// practice 页没有 button.submit（exam 才有），而是逐题即时反馈，
					// 答完后由独立的 practiceFinish 脚本点击「完成」(div.btn.submit.finished) 收尾。
					// 若不跳过，会因找不到 button.submit 误报"提交失败"，并干扰 practiceFinish。
					if (location.search.includes('type=practice')) {
						$msg_and_log('info', '练习模式已答完，统一提交由练习完成脚本接管，跳过此处提交。');
						return;
					}

					CommonProject.scripts.render.methods.minimize();
					CommonProject.scripts.render.methods.setPosition(100, 200);

					// 提交前记录总题数（此时答题卡 .select-item-list 还在）。
					// ⚠️ 必须在提交前算——提交后页面切到结算页，答题卡 DOM 消失，
					// querySelectorAll('.select-item-list span') 返回0 → totalQuestions 错误
					// → 结算页等待逻辑失效（等不到足够 .right-answer）→ 缓存不全。
					const totalQuestions = document.querySelectorAll('.select-item-list span').length || 5;
					_diag('提交前总题数=' + totalQuestions);
					// 找提交按钮，并处理 noClick（未答完被禁用）的情况。
					// ⚠️ 实测：submit.click() 本身有效（能触发慕享提交），但按钮带 .noClick 时
					// 点击无效。旧代码遇到 noClick 直接跳过 → 用户看到"3秒后自动提交"却没提交。
					// 修复：noClick 时等待并重试（慕享异步更新答题状态），仍不行则明确报错。
					let submitted = false;
					for (let attempt = 0; attempt < 5; attempt++) {
						const submit = document.querySelector<HTMLButtonElement>('button.submit');
						if (!submit) {
							$msg_and_log('warn', '未找到提交按钮，可能页面已变化。');
							break;
						}
						if (submit.classList.contains('noClick')) {
							// 慕享认为未答完，等一下重试（等异步状态更新）
							console.log('[OCS-moycp] 提交按钮被禁用(noClick)，等待重试...', attempt + 1);
							await humanSleep(800, 1500);
							continue;
						}
						// 按钮可点，点击提交
						submit.click();
						submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
						submitted = true;
						break;
					}

					if (!submitted) {
						$msg_and_log('error', '提交失败：提交按钮被禁用或不存在（部分题目可能未答完）。请手动提交。');
						return;
					}

					// 提交后等待结算页加载（结算页含 .right-answer 正确答案，Vue 异步渲染）
					// ⚠️ 结算页题目是逐题异步渲染的（MCP 实测确认，2026-06）：
					//    提交后第1题的 .right-answer 很快出现，但其余题目要几秒才陆续渲染完。
					//    旧代码用 document.querySelector('.right-answer')（单个）判断 ready，
					//    第1题一出现就 break → 此时只有1题 → parseResultPageAnswers 只缓存1题，
					//    其余题没缓存 → 下次重闯不命中 → 又走 AI 答错（"答题错误"根因）。
					//
					// 修复：等待所有题目的 .right-answer 都渲染完——用提交前记录的 totalQuestions，
					//    轮询直到 .right-answer 数量 ≥ 总题数，或数量连续3次稳定（兜底），最多 20 秒。
					let resultReady = false;
					let prevCount = 0;
					let stableCount = 0;
					for (let w = 0; w < 20000; w += 500) {
						await $.sleep(500);
						if (isStopped()) return;
						const raCount = document.querySelectorAll('.right-answer').length;
						if (raCount >= totalQuestions) {
							resultReady = true;
							break;
						}
						// 兜底：数量连续3次不变且>0（可能总题数统计有误，但渲染已稳定）
						if (raCount > 0 && raCount === prevCount) {
							stableCount++;
							if (stableCount >= 3) {
								resultReady = true;
								break;
							}
						} else {
							stableCount = 0;
						}
						prevCount = raCount;
					}
					if (!resultReady) {
						console.warn('[OCS-moycp] 提交后 20 秒内结算页未完整渲染，跳过答案记录');
					}
					// 再多等一会确保 Vue 完成所有 DOM 更新
					await humanSleep(1000, 1500);

					// 1. 解析结算页正确答案并写入题库缓存
					//    （下次重闯时 searchAnswerInCaches 命中，不再调 AI）
					// ⚠️ 答案记录用 try/catch 隔离——记录失败绝不能中断后续回退/重闯流程。
					//    历史教训：曾因 parseResultPageAnswers/saveCorrectAnswersToCache 抛错导致不回退。
					$dbg('结算页流程: 开始记录正确答案');
					// 🔍 诊断：结算页渲染状态
					const diagDl = document.querySelectorAll('dl.question-list').length;
					const diagRa = document.querySelectorAll('.right-answer').length;
					_diag('结算页状态(滚前): dlCount=' + diagDl + ' rightAnswer=' + diagRa + ' 总题=' + totalQuestions);

					// ⚠️ 结算页题目可能是懒加载（滚动才渲染）。MCP 观察到提交后 dlCount=1，
					//    但手动滚动后能看到所有题。这里主动滚动触发全部题目渲染。
					const scrollContainer =
						document.querySelector('.answer-panel-container') ||
						document.querySelector('.exam-result') ||
						document.querySelector('.question-list')?.parentElement ||
						document.scrollingElement ||
						document.body;
					const beforeScrollDl = document.querySelectorAll('dl.question-list').length;
					for (const y of [200, 600, 1200, 2000, 3000, 0]) {
						scrollContainer.scrollTo({ top: y, behavior: 'auto' });
						await $.sleep(400);
					}
					const afterScrollDl = document.querySelectorAll('dl.question-list').length;
					_diag('结算页状态(滚后): dlCount=' + afterScrollDl + '(滚前' + beforeScrollDl + ') rightAnswer=' + document.querySelectorAll('.right-answer').length);

					try {
						let correctAnswers = parseResultPageAnswers();
						// ⚠️ 如果缓存题数不够（结算页没渲染全），多等几秒再试一次
						// （用户反馈"自动跳转太快"——确保缓存全了再跳）
						if (correctAnswers.length < totalQuestions) {
							_diag('缓存不全(' + correctAnswers.length + '/' + totalQuestions + ')，再等5秒重试');
							await $.sleep(5000);
							correctAnswers = parseResultPageAnswers();
						}
						saveCorrectAnswersToCache(correctAnswers);
						$dbg(`结算页流程: 答案记录完成（${correctAnswers.length}/${totalQuestions} 题）`);
					} catch (e) {
						$dbg('结算页流程: 答案记录出错（已忽略，继续回退）: ' + (e instanceof Error ? e.message : String(e)));
					}

					// 2. 检测是否闯关失败 → 失败则用缓存答案重闯当前小节
					$dbg('结算页流程: 检测闯关结果');
					if (isExamFailed()) {
						$dbg('结算页流程: 闯关失败，尝试重闯');
						if (retryCurrentExam()) {
							// 已发起重闯（重新导航回答题页），不再跳目录
							return;
						}
						// 重闯达上限，继续往下跳目录
					} else {
						// 闯关成功，清除该小节的重闯计数
						const successItemId = new URLSearchParams(location.search).get('itemId') || '';
						if (successItemId) clearRetryCount(successItemId);
						$msg_and_log('info', '闯关成功');
						$dbg('结算页流程: 闯关成功');
					}

					// 3. 成功 或 重闯达上限：返回课程目录页（由 course 脚本继续下一节）
					// ⚠️ 不能用 history.back()——闯关入口是视频页 pushState 进来的，
					// back 只会回到刚看过的视频页，又被 study 脚本接管重新进入答题。
					// 直接导航到课程目录（用当前 courseId），由 course 脚本处理下一节。
					const courseId = new URLSearchParams(location.search).get('courseId');
					$msg_and_log('info', '答题已提交，返回课程目录继续下一节');
					$dbg(`结算页流程: 准备回退到目录页 (courseId=${courseId || '无'})`);
					if (courseId) {
						location.href = `/courseDetail/catalog?courseId=${courseId}`;
					} else {
						history.back();
					}
				}
			}
		});
	})();

	return worker;
}
