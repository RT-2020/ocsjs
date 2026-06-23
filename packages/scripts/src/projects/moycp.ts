import { $, OCSWorker, defaultAnswerWrapperHandler, SimplifyWorkResult } from '@ocsjs/core';
import { $message, Project, Script, $ui, $store } from 'easy-us';
import { CommonWorkOptions, playMedia } from '../utils';
import { CommonProject } from './common';
import { commonWork, optimizationElementWithImage, removeRedundantWords, simplifyWorkResult } from '../utils/work';
import { $console, BackgroundProject } from './background';
import { waitForMedia, waitFor, waitForElement } from '../utils/study';
import { playbackRate, volume } from '../utils/configs';

const $msg_and_log = (type: 'info' | 'warn' | 'error', msg: string) => {
	$message[type](msg);
	$console[type](msg);
};

/**
 * 模拟人工操作的随机延迟，降低被慕享反作弊检测的风险。
 *
 * @param minMs 最小延迟（毫秒）
 * @param maxMs 最大延迟（毫秒）
 * @returns Promise，在 [minMs, maxMs] 区间内的随机时间后 resolve
 */
const humanSleep = (minMs = 150, maxMs = 350) =>
	$.sleep(minMs + Math.floor(Math.random() * (maxMs - minMs + 1)));

const state = {
	currentMedia: undefined as HTMLMediaElement | undefined,
	currentUrl: '',
	currentRunningScriptName: '',
	current_job_id: '',
	// work.main 防重入锁：多条触发路径（oncomplete/dispatcher/study 主动）互斥
	workRunning: false,
	// 闯关失败自动重闯计数（按 itemId 区分会话内同一小节的重闯次数）
	examRetryCount: {} as Record<string, number>
};

/** 获取当前页面的路由标识（pathname，用于匹配 runAtUrl） */
const getCurrentPath = () => location.pathname;

/** 判断当前 URL 是否包含任一关键词（用于脚本匹配） */
const urlMatches = (keywords: string[]) => {
	const full = location.pathname + location.search;
	return keywords.some((k) => full.includes(k));
};

/**
 * 慕享 (moycp.com) 网课平台适配
 *
 * 页面路由：
 * - 学习中心：  /studyCenter/studying
 * - 课程目录：  /courseDetail/catalog?courseId=
 * - 今日任务：  /courseDetail/dailyTask?courseId=
 * - 视频课件页：/courseware2?courseId=&chapterId=&itemId=
 * - 闯关答题页：/study?courseId=&chapterId=&itemId=&examType=&type=exam
 *
 * 调度架构（URL 驱动重入，参考 icourse）：
 * dispatcher 监听 URL，匹配到对应脚本就调 main，main 只处理当前页面一件事，
 * 做完后通过点击/导航让 URL 变化，dispatcher 自动重入下一阶段。
 *
 * 视频播放器为自研播放器，class 前缀 `pv-`。
 * 答题为单题逐题展示模式（一次一题，点下一题切换）。
 */
export const MoycpProject = Project.create({
	name: '慕享',
	domains: ['web.moycp.com', 'moycp.com'],
	scripts: {
		/**
		 * 调度器（URL 驱动重入）
		 *
		 * 监听 URL 变化，遍历子脚本匹配 runAtUrl 配置，
		 * 匹配则调 main({canRun, job_id})，break 保证互斥。
		 * canRun 闭包让长任务在 URL 变化时自动终止。
		 */
		dispatcher: new Script({
			name: '调度器',
			hideInPanel: true,
			matches: [['所有页面', 'moycp.com']],
			oncomplete() {
				setInterval(() => {
					const url = location.href;
					if (state.currentUrl !== url) {
						// URL 变化诊断：帮助定位 SPA 跳转后各脚本的匹配情况
						console.log('[OCS-moycp] URL 变化:', state.currentUrl.slice(-40), '->', url.slice(-40));
						state.currentUrl = url;
						state.currentRunningScriptName = '';
					}
					// 遍历子脚本，匹配 runAtUrl 配置，触发对应 main
					for (const key in MoycpProject.scripts) {
						if (Object.prototype.hasOwnProperty.call(MoycpProject.scripts, key)) {
							const script = (MoycpProject.scripts as any)[key] as Script<{ runAtUrl: { defaultValue: string[] } }>;
							const runAtUrl = script.cfg.runAtUrl as string[] | undefined;
							if (runAtUrl && runAtUrl.length && urlMatches(runAtUrl)) {
								if (state.currentRunningScriptName !== script.name) {
									console.log('[OCS-moycp] dispatcher 匹配到脚本:', script.name, '| 当前已运行:', state.currentRunningScriptName || '无');
									state.currentRunningScriptName = script.name;
									state.current_job_id = Math.random().toString(16).slice(2);
									script.methods?.main?.({
										canRun: () => urlMatches(runAtUrl),
										job_id: state.current_job_id
									});
								}
								break; // 互斥：一次只触发一个脚本
							}
						}
					}
				}, 1000);
			}
		}),
		guide: new Script({
			name: '💡 使用提示',
			matches: [['', 'moycp.com']],
			namespace: 'moycp.guide-v1',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'手动进入任意课程的「课件」页面即可自动学习视频',
						'学习完毕后点击「去闯关」进入答题页即可自动答题',
						'答题前请在 “通用-全局设置” 中配置题库'
					]).outerHTML
				}
			},
			oncomplete() {
				CommonProject.scripts.render.methods.pin(this);
			}
		}),
		/**
		 * 课程目录/今日任务脚本
		 *
		 * 遍历小节，逐个点"课件"进入视频页（由 study 脚本接管）。
		 * 视频看完+答题完成后会 history.back 回到这里，dispatcher 重入本脚本继续下一节。
		 *
		 * 目录页选择器（MCP 实测确认）：
		 * - 小节容器：.content-section（含课件按钮 div.study、进度 .alreadyStudyProgress i）
		 * - 课件按钮：div.study
		 * - 进度文字：.alreadyStudyProgress i（文本如 "100%"/"66%"）
		 */
		course: new Script({
			name: '📚 课程目录脚本',
			namespace: 'moycp.course-v1',
			matches: [
				['课程目录', 'moycp.com/courseDetail/catalog'],
				['今日任务', 'moycp.com/courseDetail/dailyTask']
			],
			configs: {
				runAtUrl: { defaultValue: ['/courseDetail/catalog', '/courseDetail/dailyTask'] }
			},
			methods() {
				return {
					main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
						CommonProject.scripts.render.methods.pin(this);
						// 等待小节列表加载
						await waitForElement('div.study', { timeout_seconds: 15 });
						if (!canRun()) return;
						await $.sleep(2000); // 等 Vue 完全渲染

						// 收集所有"课件"按钮（每个对应一个小节）
						const getStudyButtons = () => Array.from(document.querySelectorAll<HTMLDivElement>('div.study'));
						let studyButtons = getStudyButtons();

						// 找到第一个未完成的小节（进度 < 100%）
						// 每个课件按钮所在的 section 容器内有 .alreadyStudyProgress i 显示进度
						//
						// ⚠️ 历史问题：closest('[class*="section"],[class*="item"]') 会匹配大量无关祖先
						// （页面里含 "section"/"item" 子串的类非常多），导致进度查询落空，fallback '0%'
						// 把所有小节都误判为"未完成"，于是反复点进已看过的视频。
						// 修复：沿父链向上有限步查找 .alreadyStudyProgress（不依赖单一层级），
						//      找不到进度时按"已完成"跳过并打印诊断日志，避免死循环。
						const findProgressElFor = (btn: HTMLElement): HTMLElement | null => {
							// 向上最多 8 层父节点查找进度元素
							let node: HTMLElement | null = btn;
							for (let i = 0; i < 8 && node; i++) {
								const el = node.querySelector<HTMLElement>('.alreadyStudyProgress i');
								if (el) return el;
								node = node.parentElement;
							}
							return null;
						};
						const findUnfinishedSection = (): HTMLDivElement | undefined => {
							studyButtons = getStudyButtons();
							for (const btn of studyButtons) {
								const progressEl = findProgressElFor(btn);
								if (!progressEl) {
									// 找不到进度元素：无法判定，按已完成跳过（不再误判为 0% 进度）
									console.warn('[OCS-moycp] 未找到进度元素，跳过该小节（视为已完成）:', btn);
									continue;
								}
								const progressText = progressEl.textContent?.trim() || '0%';
								const progress = parseInt(progressText) || 0;
								if (progress < 100) {
									return btn;
								}
							}
							return undefined;
						};

						let safetyCount = 0;
						const MAX_ITERATIONS = 50; // 防死循环

						while (canRun() && safetyCount < MAX_ITERATIONS) {
							safetyCount++;
							const unfinishedBtn = findUnfinishedSection();
							if (!unfinishedBtn) {
								$msg_and_log('info', '当前页所有小节已完成，返回上一页继续。');
								await $.sleep(1500);
								history.back();
								return;
							}

							// 获取小节名用于日志（沿父链查找，避免选错容器读到"未知小节"）
							let sectionName = '未知小节';
							{
								let node: HTMLElement | null = unfinishedBtn;
								for (let i = 0; i < 8 && node; i++) {
									const name =
										node.querySelector('.catalog-top span')?.textContent?.trim() ||
										node.querySelector('.title')?.textContent?.trim();
									if (name) {
										sectionName = name;
										break;
									}
									node = node.parentElement;
								}
							}

							$msg_and_log('info', `进入小节学习：${sectionName}`);
							// 点击课件按钮 → URL 变成 /courseware2 → dispatcher 触发 study 脚本
							unfinishedBtn.click();
							unfinishedBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

							// 等待离开当前页面（study 脚本接管后会跳到 /courseware2）
							// study 处理完（视频+答题）后会 history.back 回到这里
							// 这里等待 URL 变回 courseDetail
							const startPath = location.pathname;
							let waited = 0;
							while (canRun() && waited < 600000) {
								// 600秒超时（一个完整视频+答题可能很久）
								await $.sleep(2000);
								waited += 2000;
								// 离开了目录页，说明 study 接管了
								if (location.pathname !== startPath) break;
							}
							// 等 study/work 处理完，URL 变回 courseDetail
							while (canRun() && waited < 600000) {
								await $.sleep(2000);
								waited += 2000;
								if (location.pathname.includes('/courseDetail')) break;
							}
							if (!canRun()) return;
							await $.sleep(2000); // 等页面重新渲染
						}
					}
				};
			}
		}),
		study: new Script({
			name: '🖥️ 学习脚本',
			namespace: 'moycp.study-v1',
			matches: [
				['视频课件页', 'moycp.com/courseware2'],
				['视频课件页', 'moycp.com/courseware']
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'请勿在使用过程中最小化浏览器',
						'视频播完后会自动点击「去闯关」进入答题，答题完成后自动回目录继续下一节'
					]).outerHTML
				},
				// runAtUrl 供 dispatcher 匹配，触发本脚本的 main
				runAtUrl: { defaultValue: ['/courseware2', '/courseware'] },
				playbackRate: playbackRate,
				volume: volume
			},
			oncomplete() {
				this.onConfigChange('playbackRate', (playbackRate) => {
					if (state.currentMedia) {
						state.currentMedia.playbackRate = parseFloat(playbackRate.toString());
					}
				});
				this.onConfigChange('volume', (v) => {
					if (state.currentMedia) {
						state.currentMedia.volume = v;
					}
				});
			},
			methods() {
				return {
					/**
					 * 单视频处理（URL 驱动重入，每次只播当前一个视频）
					 *
					 * 流程：播放（含 onpause 续播）→ 播完 → 自动点"去闯关"进入答题
					 *      → 或无闯关则 history.back 回目录页
					 * 答题/目录页由 dispatcher 触发对应脚本重入。
					 */
					main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
						CommonProject.scripts.render.methods.pin(this);

						const playbackRate = parseFloat(this.cfg.playbackRate.toString());
						const volume = this.cfg.volume;

						$msg_and_log('info', '检测到视频课件，开始学习');
						const media = await waitForMedia({ videoSelector: 'video.pv-video, video' });
						if (!canRun()) return;
						state.currentMedia = media;

						// 应用倍速与音量
						media.playbackRate = playbackRate;
						media.volume = volume;

						// onpause 续播：慕享或浏览器可能暂停视频，自动恢复
						media.onpause = async () => {
							if (!media.ended && canRun()) {
								await $.sleep(500);
								media.play();
							}
						};

						// ⚠️ 历史问题：之前看过的视频，再次打开时 currentTime 可能接近结尾、或 ended=true，
						// 导致旧代码首次轮询（1秒）就命中 currentTime >= duration - 0.5 瞬间判定"完成"。
						// 修复：
						//   1. 若进入时已处于结尾，先重置 currentTime=0 再播放（重新看一遍）
						//   2. 记录起始 currentTime，必须"真正播放推进 ≥1 秒"后才允许触发结束判定
						// 等 duration 元数据加载完成（自研播放器可能稍后才给出 duration）
						const waitForDuration = async (timeoutMs = 15000) => {
							const start = Date.now();
							while (Date.now() - start < timeoutMs) {
								if (media.duration && isFinite(media.duration) && media.duration > 0) return;
								await $.sleep(300);
							}
						};
						await waitForDuration();

						// 若已停在结尾，重置到开头重播（避免瞬间误判完成）
						if (media.duration && media.currentTime >= media.duration - 0.5) {
							console.log('[OCS-moycp] 进入页面时视频已在结尾，重置到开头重播');
							try {
								media.currentTime = 0;
							} catch {
								/* 忽略重置失败 */
							}
						}

						const startCurrentTime = media.currentTime;

						// 播放
						const played = await playMedia(() => media.play());
						if (!played) {
							$msg_and_log('error', '视频播放失败，请手动点击播放后重试。');
							return;
						}

						// 等待播放结束
						// 关键：必须先"真正播放过"（currentTime 比 startCurrentTime 推进 ≥1秒），
						// 才允许 ended / 结尾兜底判定触发，否则会瞬间误判完成。
						await new Promise<void>((resolve) => {
							let playedEnough = false;
							const onEnd = () => {
								media.removeEventListener('ended', onEnd);
								resolve();
							};
							media.addEventListener('ended', onEnd);
							// 轮询兜底（自研播放器 ended 事件可能不触发）
							const interval = setInterval(() => {
								if (!canRun()) {
									clearInterval(interval);
									media.removeEventListener('ended', onEnd);
									resolve();
									return;
								}
								// 标记"已真正播放"
								if (!playedEnough && media.currentTime - startCurrentTime >= 1) {
									playedEnough = true;
								}
								// 仅在确实播放过之后，才允许结尾/ended 触发完成
								if (playedEnough && (media.ended || media.currentTime >= media.duration - 0.5)) {
									clearInterval(interval);
									media.removeEventListener('ended', onEnd);
									resolve();
								}
							}, 1000);
						});

						if (!canRun()) return;
						$msg_and_log('info', '视频学习完成');

						// 视频播完，尝试自动点击「去闯关」进入答题页
						// 慕享会先弹确认框「准备好去闯关了吗？」需自动确认
						//
						// ⚠️ 历史问题：确认按钮用 textContent === '确定' 过严（可能是"确 定"/带图标/含空格），
						// 且 Vue 可能拦截 .click() 导致 URL 没真的变成 type=exam，dispatcher 自然不触发 work 脚本。
						// 修复：放宽「确定」匹配 + 点击后校验 URL 变化 + 失败重试一次 + 仍失败明确报错。

						/** 找「去闯关」按钮
						 *
						 * ⚠️ 慕享用 Element Plus，按钮文字包在 <span> 里：
						 *    <button><span>去闯关</span></button>
						 * 旧代码用 textContent==='去闯关' && children.length===0，匹配到的是内部
						 * <span>，对 span.click() 无法触发 Vue 在 <button> 上的事件 → 点击无效
						 * → URL 不变 → study 走 history.back → course 死循环（"未知小节"）。
						 *
						 * 修复：优先匹配 <button>/<a> 等可点击元素（即便有子元素），
						 *      找不到再退回到叶子节点（兼容非 Element-UI 的纯文本元素）。
						 */
						const findGoExamBtn = (): HTMLElement | undefined => {
							// 1. 优先：可点击容器（button/a/带 role）其文字含"去闯关"且较短
							const clickable = Array.from(
								document.querySelectorAll<HTMLElement>('button, a, [role="button"], .btn')
							).find((e) => (e.textContent || '').trim() === '去闯关');
							if (clickable) return clickable;
							// 2. 兜底：任意叶子节点（兼容非 Element-UI 场景）
							return Array.from(document.querySelectorAll<HTMLElement>('*')).find(
								(e) => (e.textContent || '').trim() === '去闯关' && e.children.length === 0
							);
						};
						/** 找确认弹窗里的「确定」按钮（宽松匹配：含"确定"二字即可） */
						const findConfirmBtn = (): HTMLButtonElement | undefined =>
							Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
								const txt = (b.textContent || '').replace(/\s+/g, '');
								return txt.includes('确定') || txt.includes('确认') || txt.includes('去闯关');
							});

						/** 执行一次完整的「点去闯关 → 等弹窗 → 点确定」流程 */
						const clickGoExamOnce = async (): Promise<boolean> => {
							const btn = findGoExamBtn();
							if (!btn) return false;
							btn.click();
							btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
							// 等确认弹窗出现
							await $.sleep(1000);
							const confirmBtn = await waitFor(findConfirmBtn, { timeout_seconds: 3 });
							if (confirmBtn) {
								confirmBtn.click();
								confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
							}
							return true;
						};

						/** 校验 URL 是否已变为答题页（dispatcher 据此触发 work） */
						const isOnExamPage = () => location.href.includes('type=exam');

						const goExamBtn = await waitFor(findGoExamBtn, { timeout_seconds: 3 });

						if (goExamBtn) {
							$msg_and_log('info', '点击「去闯关」进入答题');

							// 第一次尝试
							await clickGoExamOnce();
							// 校验 URL 是否变化（等 3 秒）
							let navigated = await waitFor(isOnExamPage, { timeout_seconds: 3 });

							// 没变化 → 重试一次
							if (!navigated) {
								console.warn('[OCS-moycp] 第一次点去闯关后 URL 未变为 type=exam，重试一次');
								await $.sleep(1000);
								await clickGoExamOnce();
								navigated = await waitFor(isOnExamPage, { timeout_seconds: 3 });
							}

							if (!navigated) {
								// 仍失败：明确告知用户，避免脚本静默卡死
								$msg_and_log(
									'error',
									'点击「去闯关」后未能进入答题页（可能需要手动点击）。'
								);
							} else {
								// ⚠️ 关键修复：SPA 跳转到 type=exam 后，不能只被动等 dispatcher
								// 触发 work —— 实测中 SPA 跳转存在竞态（中间态 URL、慕享反调试
								// 干扰定时器、currentRunningScriptName 状态机），导致 dispatcher
								// 的 setInterval 经常轮询不到 work，用户必须手动刷新才行。
								// 这里主动调用 work.main，绕过 dispatcher 的脆弱重入机制。
								$msg_and_log('info', '已进入答题页，主动触发答题脚本');
								const workScript = MoycpProject.scripts.work;
								// 同步更新 dispatcher 状态，避免后续 dispatcher tick 检测到 URL
								// 变化后又 reset 并重复触发 work.main（双重触发）。
								state.currentUrl = location.href;
								state.currentRunningScriptName = workScript.name;
								state.current_job_id = Math.random().toString(16).slice(2);
								workScript.methods?.main?.({
									canRun: () => urlMatches(workScript.cfg.runAtUrl as string[]),
									job_id: state.current_job_id
								});
							}
						} else {
							// 无闯关入口（纯视频课），返回目录页，由 course 脚本处理下一节
							$msg_and_log('info', '无闯关入口，返回课程目录继续下一节');
							await $.sleep(1500);
							history.back();
						}
					}
				};
				}
			}),
		work: new Script({
			name: '✍️ 闯关答题脚本',
			namespace: 'moycp.work-v1',
			matches: [['闯关答题页', 'moycp.com/study']],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'自动答题前请在 “通用-全局设置” 中设置题库配置。',
						'⚠️答题为逐题模式，脚本会自动切换下一题并提交。',
						'⚠️禁止同时开多个答题页面。'
					]).outerHTML
				},
				// runAtUrl 供 dispatcher 匹配。
				// ⚠️ 不能用 '/study?type=exam'——实际 URL 参数顺序是 /study?courseId=xxx&...&type=exam，
				// '/study?type=exam' 作为整体子串匹配不到。用 'type=exam' 这个唯一标识。
				runAtUrl: { defaultValue: ['type=exam'] }
			},
			methods() {
				const start = async (canRun: () => boolean, onWorkerCreated?: (worker: any) => void) => {
					// 慕享是纯 Vue 网页，无反爬，不需要 playwright 软件环境，
					// 浏览器油猴脚本即可直接 DOM 操作。
					// (若运行在 ocs-desktop 软件环境则也兼容)

					// 等待加载题目
					await waitForQuestion();

					CommonProject.scripts.render.methods.pin(this);
					CommonProject.scripts.render.methods.normal();

					$msg_and_log('info', '开始答题');
					commonWork(this, {
					workerProvider: (opts) => {
						const worker = workAndExam(opts);
						// 不再设置 canRun 导航守卫（原 1 秒轮询 canRun() 的 interval 已删除）。
						//
						// 理由（调研确认）：
						//   1. 答题循环 + answerOne 内部从不修改 location（仅点击选项/答题卡，
						//      不导航），所以正常会话内 canRun() 本应恒为 true。
						//   2. 唯一的 false 来源是 Vue Router 渲染答题卡的中间态 URL（router
						//      可能短暂 replaceState），持续可能 >2 秒，2 次防抖也覆盖不住，
						//      导致会话被误杀（用户日志证实："开始答题" 后立即误报"检测到页面切换"）。
						//   3. 这个守卫是从 icourse 复制的，但 icourse 是 playwright 远程环境 +
						//      hash 路由（离散导航无中间态）；moycp 是浏览器内 + URL 路由 +
						//      URL 驱动调度，架构不匹配。
						//
						// 安全性：循环有 3 重自行终止兜底，不依赖守卫——
						//   - MAX_ROUNDS=3 硬上限
						//   - prevUnansweredCount 两轮无进展即停
						//   - DOM 变空收敛（导航后答题卡为空 → unanswered=0 → break）
						// 手动暂停(worker.isStop)/重启(restart)通过 OCSWorker 事件机制，与守卫无关。
						return worker;
					},
						onWorkerCreated: onWorkerCreated,
						enable_control_panel: true,
						start_delay_seconds: 3
					});
				};
				return {
					main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
						// 防重入：仅防止 main 在一次调用未返回时被并发再次进入
						// （dispatcher 与 study 主动触发可能几乎同时发生）。
						// ⚠️ 锁只在本次 main 执行期间持有，不跨整个答题会话——
						// 否则 worker 的 close/done 若不触发，锁会永久卡死，导致
						// 之后再也无法触发答题。重入由 dispatcher 的 currentRunningScriptName
						// 互斥兜底，双重 commonWork 风险可接受。
						if (state.workRunning) {
							console.log('[OCS-moycp] work.main 正在执行中，跳过并发重入');
							return;
						}
						state.workRunning = true;
						try {
							$msg_and_log('info', '闯关答题脚本被触发');
							// 等页面完全加载（Vue 渲染需要时间）
							await $.sleep(2000);
							return await start(canRun);
						} finally {
							state.workRunning = false;
						}
					},
					start: start
				};
			},
			oncomplete() {
				// ⚠️ 关键修复：oncomplete 必须能自启动，不能只依赖 dispatcher。
				//
				// 框架的 getMatchedScripts 只在页面加载时执行一次。
				// - 用户【刷新】进入 type=exam 页：框架匹配到本脚本，oncomplete 触发
				//   → 这里自启动 main（这正是"刷新就好"的原因）。
				// - 用户【从视频点去闯关】SPA 跳转进来：框架不会重新匹配，
				//   oncomplete 不触发；此时由 study 脚本主动调用 work.main 兜底，
				//   同时 dispatcher 的 setInterval 也会尝试匹配。
				//
				// 三条路径中任意一条命中即可，state.currentRunningScriptName 做互斥，
				// 保证 work.main 只触发一次。
				if (urlMatches(['type=exam']) && state.currentRunningScriptName !== this.name) {
					state.currentUrl = location.href;
					state.currentRunningScriptName = this.name;
					state.current_job_id = Math.random().toString(16).slice(2);
					this.methods?.main?.({
						canRun: () => urlMatches(['type=exam']),
						job_id: state.current_job_id
					});
				}
			}
		})
	}
});

function waitForQuestion() {
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
function workAndExam(
	{ answererWrappers, redundanceWordsText, upload, stopSecondWhenFinish, answerSeparators }: CommonWorkOptions
) {
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
	 * 提交后慕享展示结算页，结构（实测确认）：
	 *   .answer-panel-fl 下有多个 dl.question-list，每题一个 dl：
	 *     dl > .question-num("第N题") + dt(题型+.question-title 题干) + div(选项+.right-answer+.解析)
	 *   正确答案：<div class="right-answer">正确答案 :<span>A</span></div>
	 *   多选题答案如 "A C D"（span 内空格分隔）。
	 *
	 * 题干用 titleTransform 标准化，保证与 answerer 缓存读取时的 title 完全一致
	 * （searchAnswerInCaches 按 title 精确匹配）。
	 */
	const parseResultPageAnswers = (): { title: string; answer: string }[] => {
		const dls = document.querySelectorAll('dl.question-list');
		const results: { title: string; answer: string }[] = [];
		dls.forEach((dl) => {
			const titleEl = dl.querySelector<HTMLElement>('.question-title');
			const answerEl = dl.querySelector('.right-answer span');
			if (!titleEl || !answerEl) return;
			// 标准化 title（与 answerer 一致）
			const title = titleTransform([titleEl]);
			// 答案：多选如 "A C D" → "ACD"，单选/判断如 "A"/"B"
			const answer = (answerEl.textContent || '').replace(/\s+/g, '').trim();
			if (title && answer) {
				results.push({ title, answer });
				console.log('[OCS-moycp] 结算页答案: ' + title.slice(0, 20) + '... => ' + answer);
			}
		});
		return results;
	};

	/** 把结算页正确答案写入题库缓存（复用 addQuestionCacheFromWorkResult 的底层存储） */
	const saveCorrectAnswersToCache = (answers: { title: string; answer: string }[]) => {
		if (!answers.length) {
			console.log('[OCS-moycp] 结算页未提取到答案，跳过缓存');
			return;
		}
		// 转成 SimplifyWorkResult 格式，复用现有写入路径（去重、上限200、持久化）
		const swr: SimplifyWorkResult[] = answers.map((a) => ({
			question: a.title,
			type: 'unknown' as any,
			requested: true,
			resolved: true,
			searchInfos: [
				{
					name: '【题库缓存】闯关结算页记录',
					homepage: '',
					results: [[a.title, a.answer, { cache: true, ai: false }]]
				}
			]
		}));
		CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(swr);
		$msg_and_log('info', `已记录 ${answers.length} 题的正确答案到题库缓存`);
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
		/** 默认搜题方法构造器 */
		answerer: (elements, ctx) => {
			const title = titleTransform(elements.title);
			if (title) {
				return CommonProject.scripts.apps.methods.searchAnswerInCaches(title, async () => {
					// ⚠️ AI 多 key 顺序 fallback：defaultAnswerWrapperHandler 内部用
					// Promise.all 并行调用所有 wrapper，不是"失败才切换"。
					// 这里改为顺序遍历——第一个 AI 返回非空答案就用，失败/空才试下一个。
					// 这样配置多个备用 AI 时，主 AI 不可用会自动切到备用。
					const optionText = ctx.elements.options
						.map((o) => optimizationElementWithImage(o, true).innerText)
						.join('\n');
					// 非 AI wrapper（如其他题库）保持并行调用
					const nonAIWrappers = answererWrappers.filter(
						(w) => !w.name.includes('AI大模型题库')
					);
					const aiWrappers = answererWrappers.filter((w) =>
						w.name.includes('AI大模型题库')
					);
					// 先并行跑所有非 AI wrapper（题库类，无 key 限制）
					const nonAIResults =
						nonAIWrappers.length > 0
							? await defaultAnswerWrapperHandler(nonAIWrappers, {
									type: ctx.type || 'unknown',
									title,
									options: optionText
							  })
							: [];
					// 如果非 AI wrapper 有答案，直接用
					if (nonAIResults.some((r) => r.results && r.results.length > 0)) {
						return nonAIResults;
					}
					// 顺序尝试每个 AI wrapper（主→备用），第一个有答案就用
					for (let i = 0; i < aiWrappers.length; i++) {
						const aw = aiWrappers[i];
						try {
							console.log('[OCS-moycp] 尝试 AI 题库:', aw.name, `(${i + 1}/${aiWrappers.length})`);
							const results = await defaultAnswerWrapperHandler([aw], {
								type: ctx.type || 'unknown',
								title,
								options: optionText
							});
							if (results.some((r) => r.results && r.results.length > 0)) {
								console.log('[OCS-moycp] AI 题库命中:', aw.name);
								return results;
							}
							console.log('[OCS-moycp] AI 题库无结果，切换下一个:', aw.name);
						} catch (e) {
							console.log('[OCS-moycp] AI 题库出错，切换下一个:', aw.name, e);
						}
					}
					// 全部失败，返回非 AI 的结果（可能为空）
					return nonAIResults;
				});
			} else {
				throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
			}
		},
		/**
		 * 自定义工作器（绕过 resolveMultiple 的 core bug）
		 *
		 * core 的 resolveMultiple 在选项含字母前缀（"A. xxx"）时有 indexOf 错位 bug，
		 * 导致多选题全选/错选。这里自己实现匹配+选中逻辑：
		 * 1. 从 searchInfos 汇总所有答案
		 * 2. 按题型匹配选项（单选/多选/判断用文本包含 + 字母兜底，填空直接填）
		 * 3. 点击匹配的 label 触发 Vue 选中
		 */
		work: async (ctx) => {
			const options = ctx.elements.options;
			const type = ctx.type;
			// 诊断日志：确认 CustomWork 新代码生效
			const dbgAnswers = ctx.searchInfos.map((i) => i.results.map((r) => r.answer)).flat().filter(Boolean);
			console.log('[OCS-CustomWork] 题型=' + type + ' 选项数=' + options.length + ' AI答案=' + JSON.stringify(dbgAnswers));
			// 汇总所有题库的答案
			const answers = ctx.searchInfos
				.map((info) => info.results.map((r) => r.answer))
				.flat()
				.filter(Boolean) as string[];
			if (answers.length === 0) {
				return { finish: false };
			}

			// 填空题：找输入框填入答案
			if (type === 'completion') {
				const answer = answers[0].trim();
				// 模拟人工思考后再填写
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

			// 单选/多选/判断题：匹配选项并选中
			// answers 可能是 "AC"、"A#C"、"思维能否#存在和思维"、"正确" 等
			// 拆分所有答案为单个 token
			const tokens = new Set<string>();
			for (const ans of answers) {
				// 按 # / 空格 / 逗号拆分
				for (const part of ans.split(/[#\s,，、；;]+/).filter(Boolean)) {
					tokens.add(part.trim());
				}
				// 纯字母答案（如 "AC"）拆成单个字母
				if (/^[A-Da-d]{1,4}$/.test(ans.trim())) {
					for (const ch of ans.trim()) tokens.add(ch.toUpperCase());
				}
			}

				// ⚠️ 关键：先计算所有应选选项，再一次性同步点击。
				// 慕享多选题（checkbox）选中任一选项后约 1.8 秒会自动跳到下一题；
				// 若像旧代码那样"匹配一个就 await sleep(300) 再点下一个"，
				// 后续选项的点击会落在跳转后的新题上 → 多选题永远选不够 → 不标 .already → 死循环。
				// 解决：全部匹配计算完成后再批量同步点击（不 sleep），抢在慕享跳转前把所有选项一次性选完。
				const toSelect: { opt: HTMLElement; optText: string }[] = [];
				for (const opt of options) {
					const input = opt.querySelector('input') as HTMLInputElement | null;
					if (!input || input.checked) continue;
					const optText = opt.innerText.replace(/\s+/g, '').trim();
					let shouldSelect = false;

					for (const token of tokens) {
						const t = token.replace(/\s+/g, '');
						// 1. 字母匹配：token 是 A/B/C/D，选项以 "A."/"A、"/"A)" 开头
						if (/^[A-D]$/.test(t)) {
							if (new RegExp('^' + t + '[.、)]').test(optText)) {
								shouldSelect = true;
								break;
							}
						}
						// 2. 判断题：token 是 正确/错误，选项文本含正确/错误
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
						// 3. 文本包含匹配（去掉字母前缀后比较）
						const optNoPrefix = optText.replace(/^[A-D][.、)]/, '');
						if (optNoPrefix.includes(t) || t.includes(optNoPrefix)) {
							shouldSelect = true;
							break;
						}
					}

					if (shouldSelect) {
						toSelect.push({ opt, optText });
					}
				}

				// 逐个 label.click() 选中，每个之间加随机延迟模拟人工（150-350ms）。
				//
				// ⚠️ 实测对照（干净页面多次验证）的最终结论：
				//   - label.click() 同步批量（无延迟）→ Vue 异步冲突，多选只选中1个，不标 .already ❌
				//   - input.checked=true + change/input → 能改 DOM checked，但不触发慕享 Vue 的 click 逻辑，
				//     慕享不标记 .already（isAnswered 判定失败）❌
				//   - label.click() 逐个 + 随机延迟 → 触发慕享 Vue click handler（更新内部状态→标 .already）✅，
				//     且间隔让 Vue 完成上一次更新，避免冲突。单选/多选/判断都有效。
				// 所以正确做法 = label.click() 逐个调用 + 间隔随机延迟。
				// 注意：总耗时须小于慕享选中后约 1.8s 的自动跳转窗口。
				//   4 选项 × 平均 250ms ≈ 1s，安全在窗口内。
				let matchedCount = 0;
				for (const { opt, optText } of toSelect) {
					if (matchedCount > 0) await humanSleep(150, 350);
					const label = opt.closest('label') || opt.querySelector('label') || opt;
					label.click();
					matchedCount++;
					console.log('[OCS-CustomWork] 选中: ' + optText.slice(0, 20));
				}

			console.log('[OCS-CustomWork] 完成匹配，共选中 ' + matchedCount + ' 个');
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

			if (curr.result?.finish) {
				CommonProject.scripts.apps.methods.addQuestionCacheFromWorkResult(simplifyWorkResult([curr], titleTransform));
			}
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

		// 等待慕享标记为已答（选中后慕享异步更新 .already，最多等 4 秒）
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
					CommonProject.scripts.render.methods.minimize();
					CommonProject.scripts.render.methods.setPosition(100, 200);

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
					// ⚠️ 不能用固定 sleep——结算页渲染时间不定，太早解析会读空。
					//    改为轮询等待 .right-answer 出现（最多 15 秒）。
					let resultReady = false;
					for (let w = 0; w < 15000; w += 500) {
						await $.sleep(500);
						if (document.querySelector('.right-answer')) {
							resultReady = true;
							break;
						}
						if (isStopped()) return;
					}
					if (!resultReady) {
						console.warn('[OCS-moycp] 提交后 15 秒内未检测到结算页，跳过答案记录');
					}
					// 多等一会让所有题目渲染完
					await humanSleep(1500, 2500);

					// 1. 解析结算页正确答案并写入题库缓存
					//    （下次重闯时 searchAnswerInCaches 命中，不再调 AI）
					const correctAnswers = parseResultPageAnswers();
					saveCorrectAnswersToCache(correctAnswers);

					// 2. 检测是否闯关失败 → 失败则用缓存答案重闯当前小节
					if (isExamFailed()) {
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
					}

					// 3. 成功 或 重闯达上限：返回课程目录页（由 course 脚本继续下一节）
					// ⚠️ 不能用 history.back()——闯关入口是视频页 pushState 进来的，
					// back 只会回到刚看过的视频页，又被 study 脚本接管重新进入答题。
					// 直接导航到课程目录（用当前 courseId），由 course 脚本处理下一节。
					const courseId = new URLSearchParams(location.search).get('courseId');
					$msg_and_log('info', '答题已提交，返回课程目录继续下一节');
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
