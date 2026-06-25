import { $, defaultAnswerWrapperHandler } from '@ocsjs/core';
import { Project, Script, $ui } from 'easy-us';
import { playMedia } from '../utils';
import { CommonProject } from './common';
import { commonWork, optimizationElementWithImage, removeRedundantWords, simplifyWorkResult } from '../utils/work';
import { BackgroundProject, $console } from './background';
import { waitForMedia, waitFor, waitForElement } from '../utils/study';
import { playbackRate, volume } from '../utils/configs';
// 共享工具与状态（从 moycp-shared 导入，避免重复定义）
import { $msg_and_log, $dbg, humanSleep, state, getCurrentPath, urlMatches, videoDoneCache } from './moycp-shared';
// 答题工作器（从 moycp-work 导入，纯函数，不反向依赖本文件）
import { workAndExam, waitForQuestion } from './moycp-work';

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
		 * 遍历小节，逐个点入口按钮进入学习/闯关页（由 study/work 脚本接管）。
		 * 处理完后导航回目录页，dispatcher 重入本脚本继续下一节。
		 *
		 * 目录页 DOM 结构（MCP 实测确认，2026-06）：
		 * - 小节容器：dd.catalog-detail-dd（每个小节一个 dd）
		 * - 入口按钮区：.study-buttons 下有两个按钮
		 *     - div.study         → A 类章节显示「课件」（进视频页），B 类章节显示「练习」（直接进闯关）
		 *     - div.chuangguan    → A 类章节「闯关」，B 类章节「测试」（两类章节都有此按钮）
		 * - 视频进度：.alreadyStudyProgress i（文本如 "100%"/"26%"，仅 A 类章节有）
		 * - 闯关星级：.starLevel + span.star[×3] > img
		 *     亮星 img src 含 "Uew6vjOR0lU"，暗星 img src 含 "L+A65AUzCw2U"（仅靠 src 区分，无 class 差异）
		 *
		 * 章节分两类，完成定义不同：
		 * - A 类（有视频进度容器）：完成 = 视频进度 100% 且 星级满
		 * - B 类（无视频进度容器，纯闯关如「习题解析」）：完成 = 星级满
		 */
		course: new Script({
			name: '📚 课程目录脚本',
			namespace: 'moycp.course-v1',
			matches: [
				['课程目录', 'moycp.com/courseDetail/catalog'],
				['今日任务', 'moycp.com/courseDetail/dailyTask']
			],
			configs: {
				runAtUrl: { defaultValue: ['/courseDetail/catalog', '/courseDetail/dailyTask'] },
				/**
				 * 闯关完成标准开关（MCP 实测 + 用户确认，2026-06）。
				 *
				 * 目录页章节完成判定的星级门槛：
				 *   false（默认，现状）= 满星才算完成（litCount === starTotal）
				 *   true               = 通过即可（litCount >= 2，慕享 2 星即"任务通过"）
				 *
				 * 默认 false：对现有用户零行为变化（升级后老用户 $store 无此 key → 读到 false）。
				 * 通过模式下若某小节总星数 < 2，阈值自动等价于"满星"（如 1 星小节需 1 星=满），无副作用。
				 */
				passMode: {
					label: '通过即可（无需满星）',
					attrs: { type: 'checkbox', title: '勾选后，闯关亮星≥2 即算完成；不勾选则必须满星' },
					defaultValue: false
				},
				/**
				 * 视频优先（两阶段）开关（MCP 实测确认 DOM，2026-06）。
				 *
				 * false（默认，现状）= 按章节交替：一个 A 类小节 = 看视频 + 立即闯关，一次进入。
				 * true               = 全课两阶段：
				 *   Phase1：进任意 A 类小节视频页后，study 脚本在视频页右侧 sidebar 上连续点击
				 *           未完成项，把全课所有视频看完（不中途闯关），全绿后回目录；
				 *   Phase2：回目录后按星级(passMode)逐节闯关。
				 *
				 * 视频页 sidebar 是全课所有 A 类子视频的扁平列表（实测 44 项），
				 * 每项 dd.catalog-item-section 看完后带 span...col2.finish（绿点），
				 * 点 dd 即跳该子视频。这是 Phase1 连续播放的导航依据。
				 *
				 * 默认 false：现有用户零行为变化（老用户 $store 无此 key → 读到 false）。
				 * 阶段恢复用「懒推断」——study 每次进视频页重读 sidebar 真实状态决定走
				 * Phase1 还是直接闯关，不存持久化 phase 标志，关浏览器重进/换设备都正确。
				 */
				videoFirst: {
					label: '视频优先（先看完所有视频再闯关）',
					attrs: { type: 'checkbox', title: '勾选：先在视频页连续看完所有视频，再回目录逐节闯关' },
					defaultValue: false
				}
			},
			methods() {
				return {
						main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
							// 版本标记：course 脚本 main 被调用时立即输出。若后台日志看不到这条，
							// 说明加载的是旧版本（@require 缓存未刷新），需重新触发油猴抓取。
							$console.log('[moycp] course 脚本已启动 v2（星级判定版）');
							// 闯关完成标准：按 config 读一次（this = Script 实例，main 内可访问 this.cfg）。
							//   false（默认）= 满星才完成；true = 亮星≥2 即通过
							const passMode = !!this.cfg.passMode;
							CommonProject.scripts.render.methods.pin(this);
							// 等待小节列表加载
							await waitForElement('div.study', { timeout_seconds: 15 });
						if (!canRun()) return;
						await $.sleep(2000); // 等 Vue 完全渲染

						// 收集所有入口按钮（每个小节的 div.study：A 类是「课件」，B 类是「练习」）
						const getStudyButtons = () => Array.from(document.querySelectorAll<HTMLDivElement>('div.study'));
						let studyButtons = getStudyButtons();

						/**
						 * 沿父链向上查找小节根容器 dd.catalog-detail-dd
						 *
						 * ⚠️ 不用 closest('[class*="section"]')——页面里含 "section"/"item" 子串的类非常多，
						 *    会匹配到大量无关祖先。dd.catalog-detail-dd 是慕享小节的稳定锚点。
						 */
						const findSectionDd = (btn: HTMLElement): HTMLElement | null => {
							let node: HTMLElement | null = btn;
							for (let i = 0; i < 8 && node; i++) {
								if (node.classList?.contains('catalog-detail-dd')) return node;
								node = node.parentElement;
							}
							return null;
						};
						/**
						 * 判定小节类型（MCP 实测确认，2026-06）：
						 * - A 类（视频+闯关）：dd 内有 .alreadyStudyProgress，目录按钮区 study=「课件」/chuangguan=「闯关」
						 * - B 类（纯闯关/阶段作业/习题解析）：dd 内无 .alreadyStudyProgress，study=「练习」/chuangguan=「测试」
						 *
						 * ⚠️ 入口选择关键：
						 *   A 类必须先点 study「课件」看视频（看完才能闯关）；
						 *   B 类必须点 chuangguan「测试」进 exam 页（给满星），
						 *   ⚠️ 不能点 study「练习」——练习只给 2 星且会重复，无法拿满星（历史 bug）。
						 */
						const getSectionType = (dd: HTMLElement | null): 'A' | 'B' => {
							return dd?.querySelector('.alreadyStudyProgress') ? 'A' : 'B';
						};

						/**
						 * 判定一个小节是否真正完成。
						 *
						 * 按章节类型分别判断（MCP 实测确认的 DOM 差异）：
						 * - A 类（有 .alreadyStudyProgress）：完成 = 视频进度 100% 且 闯关星级满
						 * - B 类（无 .alreadyStudyProgress，纯闯关）：完成 = 闯关星级满
						 *
						 * 星级读取：span.star img 的 src 区分亮/暗
						 *   亮星 src 含 "Uew6vjOR0lU"，暗星 src 含 "L+A65AUzCw2U"（无 class 差异，只靠 src）
						 *
						 * ⚠️ 历史问题（已修复）：
						 *   1. 旧代码只看视频进度，视频 100% 就跳过 → A 类「视频看完但星级不满」被遗漏
						 *   2. 旧代码找不到进度元素就 continue → B 类（无视频的纯闯关章节）全部被跳过
						 *
						 * @returns 'finished'=已完成可跳过, 'unfinished'=未完成需进入, 'unknown'=无法判定（安全跳过）
						 */
						const checkSectionStatus = (btn: HTMLElement): 'finished' | 'unfinished' | 'unknown' => {
							const dd = findSectionDd(btn);
							const title = dd?.querySelector('.catalog-top span:last-child')?.textContent?.trim() || '未知小节';
							if (!dd) {
								$console.warn('[OCS-moycp] 未找到小节根容器 dd，无法判定状态:', title);
								return 'unknown';
							}

							// 星级统计（两类章节都有星级）
							const starImgs = Array.from(dd.querySelectorAll<HTMLImageElement>('span.star img'));
							const litCount = starImgs.filter((img) => (img.getAttribute('src') || '').includes('Uew6vjOR0lU')).length;
							const starTotal = starImgs.length;
							// 星级达标判定（按「闯关完成标准」开关分支，passMode 来自 main 作用域）：
							//   满星模式（默认）: litCount === starTotal
							//   通过即可模式    : litCount >= 2（MCP 实测+用户确认，慕享 2 星 = 任务通过；
							//                    总星数<2 时自动等价于满星，无副作用）
							const starFull = starTotal > 0 && (passMode ? litCount >= 2 : litCount === starTotal);

						// 视频进度（仅 A 类章节有）
						const progressEl = dd.querySelector<HTMLElement>('.alreadyStudyProgress i');
						const hasVideo = !!progressEl;
						const progressText = hasVideo ? progressEl!.textContent?.trim() || '0%' : '无视频';
						const videoDone = !hasVideo || (parseInt(progressText) || 0) >= 100; // B 类无视频默认已满足

						// 判定结果（同时写后台日志面板 + 页面调试浮层，方便排查）
						//
						// ⚠️ 核心规则（MCP 实测确认，2026-06）：
						//   课程目录的进度条（.alreadyStudyProgress）是章节聚合进度，会延迟/不准；
						//   视频页右上角进度（span.alreadystudy）才准确。
						//   完成判定 = 星级满 且（目录进度100% 或 视频完成缓存命中）。
						//
						//   "视频完成缓存"记录的是"该章节视频已在视频页右上角确认 100%"（study 脚本写入）。
						//   这样解决"星级满但目录进度<100%"的死循环：
						//     - 目录进度已100% → finished（正常）
						//     - 目录进度<100% 但缓存命中 → finished（目录延迟，视频页已二次验证过100%）
						//     - 目录进度<100% 且缓存未命中 → unfinished（course 会主动进视频页二次验证，
						//       study 确认右上角100%后写缓存，回目录后下次判 finished）
						//     - 星级未满 → unfinished（需继续看视频+闯关，不跳过视频环节）
						const courseId = new URLSearchParams(location.search).get('courseId') || '';
						const videoDoneCached = videoDoneCache.has(courseId, title);
						const status: 'finished' | 'unfinished' =
							starFull && (videoDone || videoDoneCached) ? 'finished' : 'unfinished';
						const type = hasVideo ? 'A视频+闯关' : 'B纯闯关';
						$dbg(
							`判定: ${title} | 类型=${type} | 模式=${passMode ? '通过(≥2星)' : '满星'} | 视频=${progressText} | 星级=${litCount}/${starTotal} | 缓存=${videoDoneCached ? '命中' : '未命中'} | 结果=${status}`
						);
						return status;
						};

						/**
						 * 找第一个未完成的小节
						 *
						 * 防死循环：用 triedKeys 记录本轮已选中过的未完成小节标题，
						 * 如果同一小节被二次选中（说明补闯关后星级没变化，题库无答案等），
						 * 就不再选它，避免无限循环进入。
						 */
						const findUnfinishedSection = (triedKeys?: Set<string>): HTMLDivElement | undefined => {
							studyButtons = getStudyButtons();
							for (const btn of studyButtons) {
								if (checkSectionStatus(btn) !== 'unfinished') continue;
								// 防死循环：已尝试过且状态未变的小节跳过
								if (triedKeys) {
									const dd = findSectionDd(btn);
									const title =
										dd?.querySelector('.catalog-top span:last-child')?.textContent?.trim() || '未知小节';
									const key =
										title +
										'|' +
										(dd?.querySelector('.alreadyStudyProgress i')?.textContent?.trim() || '') +
										'|' +
										Array.from(dd?.querySelectorAll('span.star img') || []).filter((img) =>
											(img.getAttribute('src') || '').includes('Uew6vjOR0lU')
										).length;
									if (triedKeys.has(key)) {
										$dbg(`跳过已尝试且状态未变的小节: ${title}（可能题库无答案）`);
										continue;
									}
									triedKeys.add(key);
								}
								return btn;
							}
							return undefined;
						};

						let safetyCount = 0;
						const MAX_ITERATIONS = 50; // 防死循环
						// 防死循环：记录已尝试过且状态未变化的未完成小节（如题库无答案，补闯关后星级不变）
						const triedKeys = new Set<string>();
						//
						// ⚠️ videoFirst（视频优先）两阶段模式下，course 脚本【故意不感知阶段】：
						//   始终按「星级未达标(passMode)」找未完成小节进入。阶段切换完全由 study 脚本在
						//   视频页读 sidebar 真实状态懒判定（详见 study main 的 videoFirst 分流）。
						//   这样恢复天然正确：重进目录时 course 照常按星级找小节，进视频页后 study 按
						//   sidebar 决定走 Phase1（连续播放）还是直接闯关（Phase2/恢复），零持久化标志。
						//   防死循环：triedKeys 已覆盖「course 反复进同一 A 类小节」——补闯关后星级不变
						//   的小节 key 不变会被跳过；若视频完成后目录进度变化导致 key 变，study 进视频页
						//   会发现 sidebar 全 finish 直接闯关（Phase2），自纠不空转。

						while (canRun() && safetyCount < MAX_ITERATIONS) {
							safetyCount++;
							const unfinishedBtn = findUnfinishedSection(triedKeys);
							if (!unfinishedBtn) {
								if (triedKeys.size > 0) {
									// 文案按完成标准分支：满星模式说"未满星"，通过模式说"未通过"
									const adj = passMode ? '未通过' : '未满星';
									$msg_and_log(
										'warn',
										`当前页仍有 ${triedKeys.size} 个小节${adj}，但已尝试补闯关且状态未变化（可能题库无答案），跳过并返回上一页。`
									);
									$dbg(`流程: 仍有 ${triedKeys.size} 个小节${adj}且状态不变，返回上一页`);
								} else {
									$msg_and_log('info', '当前页所有小节已完成，返回上一页继续。');
									$dbg('流程: 当前页所有小节已完成，返回上一页');
								}
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
							// 按章节类型选择正确入口按钮（MCP 实测确认，2026-06）：
							//   A 类（有视频）：点 study「课件」→ 看视频 → 视频页 study 脚本接管
							//   B 类（纯闯关/阶段作业）：点 chuangguan「测试」→ 进 exam 页 → work 脚本答题拿满星
							//     ⚠️ B 类绝不能点 study「练习」（只给 2 星、会重复，无法满星）
							const dd = findSectionDd(unfinishedBtn);
							const sectionType = getSectionType(dd);
							let entryBtn: HTMLElement = unfinishedBtn;
							if (sectionType === 'B') {
								// B 类：找同 dd 内的「测试/闯关」按钮（div.chuangguan）
								const cgBtn = dd?.querySelector<HTMLElement>('div.chuangguan');
								if (cgBtn) {
									entryBtn = cgBtn;
									$dbg(`流程: B 类小节「${sectionName}」点「测试」进 exam 页（点练习只给 2 星）`);
								} else {
									$dbg(`流程: B 类小节「${sectionName}」未找到 chuangguan 按钮，回退点 study`);
								}
							}
							$dbg(`流程: 进入小节学习「${sectionName}」（类型=${sectionType}，第 ${safetyCount}/${MAX_ITERATIONS} 次迭代）`);
							// 点击入口按钮 → A 类进 /courseware2（study 接管）；B 类进 /study?type=exam（work 接管）
							entryBtn.click();
							entryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

							// 自动确认慕享的"进入练习/学习"确认弹窗
							//
							// ⚠️ 历史问题：B 类章节（习题解析）点「练习」后，慕享会弹
							//   Element Plus 的 MessageBox（.el-message-box，文案"准备好去练习了吗？"，
							//   带「取消」「确定」按钮）。旧代码点击后只等 URL 变化、不点确定，
							//   导致 URL 一直不变，死等到 600 秒超时。
							//
							// 修复：点击 study 后轮询几秒，若出现 .el-message-box 就自动点「确定」，
							//      让页面能正常跳转。限定在 .el-message-box 内找确定按钮，避免误点其他弹窗。
							// （A 类章节点「课件」通常不弹此框，轮询不到就正常超时放行，无副作用。）
							const dismissMoycpConfirmDialog = async (timeoutMs = 5000): Promise<boolean> => {
								const findMbConfirm = (): HTMLButtonElement | null =>
									document.querySelector<HTMLButtonElement>(
										'.el-message-box .el-button--primary'
									);
								const btn = await waitFor(findMbConfirm, { timeout_seconds: Math.ceil(timeoutMs / 1000) });
								if (btn) {
									$dbg('流程: 检测到慕享确认弹窗，自动点击「确定」');
									btn.click();
									btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
									return true;
								}
								return false;
							};
							await dismissMoycpConfirmDialog();

							// 等待离开当前页面（study 脚本接管后会跳到 /courseware2）
							// study 处理完（视频+答题）后会 history.back 回到这里
							// 这里等待 URL 变回 courseDetail
							const startPath = location.pathname;
							let waited = 0;
							while (canRun() && waited < 600000) {
								// 600秒超时（一个完整视频+答题可能很久）
								await $.sleep(2000);
								waited += 2000;
								// 离开了目录页，说明 study/work 接管了
								if (location.pathname !== startPath) break;
							}

							// ⚠️ 主动触发答题脚本（补 dispatcher 的缺口）
							//
							// 当从目录点「练习/闯关」SPA 跳转到答题页时，work 脚本可能不被触发：
							//   - oncomplete 只在页面首次加载时跑一次，SPA 跳转不会再触发它；
							//   - dispatcher 靠 script.cfg.runAtUrl 匹配，但 cfg 走 $store 持久化，
							//     老用户的 store 里缓存着旧版首次写入的 ['type=exam']，覆盖了新的
							//     defaultValue（含 type=practice），导致 practice 页 dispatcher 匹配不到 work。
							//   （表现为：刷新就好[oncomplete 硬编码匹配]，SPA 跳转不触发[dispatcher 旧 cfg]。）
							//
							// 修复：检测到已跳转到答题页（exam/practice）后，主动调用 work.main，
							//      复用 study→work 的主动触发模式，绕开 dispatcher 的过期持久化 cfg。
							//      互斥由 state.currentRunningScriptName 保证（work.main 内部也有 workRunning 锁）。
							if (urlMatches(['type=exam', 'type=practice']) && state.currentRunningScriptName !== MoycpProject.scripts.work.name) {
								$dbg('流程: 检测到跳转到答题页，主动触发闯关答题脚本（绕过 dispatcher 旧 cfg）');
								state.currentUrl = location.href;
								state.currentRunningScriptName = MoycpProject.scripts.work.name;
								state.current_job_id = Math.random().toString(16).slice(2);
								MoycpProject.scripts.work.methods?.main?.({
									canRun: () => urlMatches(['type=exam', 'type=practice']),
									job_id: state.current_job_id
								});
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

						/**
						 * 判定该视频是否已学完（MCP 实测确认，2026-06）。
						 *
						 * 慕享视频页对"已看过"的视频会渲染出进度标记：
						 *   <span class="alreadystudy">已学习100%</span>
						 * 这是慕享自带的"该视频已完成学习"信号，稳定可靠。
						 *
						 * ⚠️ 历史问题：下方"视频在结尾就重置重播"的兜底逻辑会把
						 *   已学完的视频也一起从头重播——对一个视频 100% 但星级未满的章节，
						 *   每次进入都被迫重看整段视频才去闯关，严重浪费时间。
						 *   修复：检测到已学完标记时跳过播放流程，直接去闯关。
						 *
						 * 判据：span.alreadystudy 存在，且解析出的百分比 ≥ 100%
						 * （兼容 "已学习100%" / "已学习 100%" 等格式）。
						 */
						const isVideoAlreadyStudied = (): boolean => {
							const mark = document.querySelector('span.alreadystudy');
							if (!mark) return false;
							// ⚠️ 必须解析百分比，只有 100% 才算学完（MCP 实测确认，2026-06）。
							//   旧逻辑用 txt.includes('已学习') 会把"已学习1%"也判为已学完 →
							//   视频才看 1% 就跳过播放直接闯关（"无脑跳练习"bug）。
							//   span.alreadystudy 文本格式："已学习100%" / "已学习 1%" 等。
							const txt = (mark.textContent || '').replace(/\s+/g, '');
							const m = txt.match(/已学习(\d+)%/);
							return !!m && parseInt(m[1]) >= 100;
						};

					/**
					 * 视频确认完成后，写入"视频完成缓存"（供目录页 checkSectionStatus 读取）。
					 *
					 * 缓存 key = courseId + 章节标题。
					 * ⚠️ 视频页与目录页的章节标题选择器不同（MCP 实测确认，2026-06）：
					 *   - 视频页：span.itemName（在 .vertical-line-left 内）
					 *   - 目录页：.catalog-top span:last-child
					 *   两处读到的标题文本一致（如"函数与极限"），保证 key 对齐。
					 * courseId 从视频页 URL 参数读取（/courseware2?courseId=...）。
					 */
					const markVideoDoneInCache = (): void => {
						const courseId = new URLSearchParams(location.search).get('courseId') || '';
						// 视频页章节标题：优先 span.itemName，回退 .catalog-top（兼容不同课程布局）
						const sectionTitle =
							document.querySelector('span.itemName')?.textContent?.trim() ||
							document.querySelector('.catalog-top span:last-child')?.textContent?.trim() ||
							'';
						if (courseId && sectionTitle) {
							videoDoneCache.set(courseId, sectionTitle);
							$dbg(`流程: 视频完成缓存已写入 [${courseId}] ${sectionTitle}`);
						}
					};

					const alreadyStudied = isVideoAlreadyStudied();

					if (alreadyStudied) {
						// 视频已学完（右上角 span.alreadystudy 确认）：跳过播放，直接去闯关
						// 同时写入完成缓存——目录页若进度条延迟<100%，靠此缓存判 finished，避免死循环
						markVideoDoneInCache();
						$msg_and_log('info', '该视频已学完，跳过播放直接去闯关');
						$dbg('流程: 检测到 span.alreadystudy（已学习），跳过重播');
						} else {
							// 视频未学完：正常播放
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
							// 视频自然播完：同样写入完成缓存（与"右上角已学习"走同一缓存，供目录页判定）
							markVideoDoneInCache();
							$msg_and_log('info', '视频学习完成');
						}

					/**
					 * 视频优先（videoFirst）两阶段：视频播完后的分流。
					 *
					 * MCP 实测确认 DOM（2026-06，真实 /courseware2 页面）：
					 *   视频页右侧 sidebar 是全课所有 A 类子视频的扁平列表（实测 44 项）：
					 *     dd.catalog-item-section（每项一个），title="子视频名"；
					 *     当前播放 dd 带 .current；看完的 dd 内 span.catalog-item-section-col2 带 .finish（绿点）。
					 *   点 dd（cursor:pointer）即跳该子视频（改 URL 的 itemId）。
					 *   播放器内无「下一节」按钮 → 跨视频导航只能点 sidebar。
					 *
					 * 分流规则（阶段恢复靠 sidebar 真实状态懒判定，零持久化标志）：
					 *   videoFirst=false（现状）：直接走下方「点去闯关」逻辑。
					 *   videoFirst=true：
					 *     sidebar 还有未 finish 项 → Phase1：点第一个「未完成且非当前」的 dd，校验导航成功
					 *       （.current 切到 target）后【自重入 study.main】播下一子视频（⚠️ sidebar 跳转
					 *       URL 不变，dispatcher 不会重入，必须自重入）；连续点同一 dd 无变化 3 次则跳过
					 *     sidebar 全 finish → 走下方「点去闯关」（Phase2 / 重进恢复场景，不重看视频）
					 */
					const videoFirst = !!MoycpProject.scripts.course.cfg.videoFirst;
					if (videoFirst && canRun()) {
						/**
						 * 读 sidebar 所有「未完成 且 非当前播放」的子视频项。
						 * 「完成」= dd 内 span.catalog-item-section-col2 带 .finish（MCP 实测确认）。
						 * 「非当前」= 不带 .current —— 刚播完的就是 .current，点它不会导航（内容已在播放），
						 *   必须排除，否则误判「点击无响应」。
						 */
						const getUnfinishedSidebarItems = (): HTMLElement[] =>
							Array.from(document.querySelectorAll<HTMLElement>('dd.catalog-item-section')).filter(
								(dd) =>
									!dd.querySelector('.catalog-item-section-col2.finish') &&
									!dd.classList.contains('current')
							);

						const unfinished = getUnfinishedSidebarItems();
						$dbg(`videoFirst: sidebar 未完成（且非当前）子视频 ${unfinished.length} 项`);

						if (unfinished.length > 0) {
							// Phase1：还有未完成视频，不闯关，点 sidebar 跳到下一未完成项继续播放
							const target = unfinished[0];
							const targetTitle = target.getAttribute('title') || '';
							$msg_and_log('info', `视频优先：继续播放下一未完成视频「${targetTitle}」`);

							// 防死循环：记录本轮点过且状态未变的 dd（点了但导航没成功）
							// 用模块级 state 暂存（会话内有效），key=title。
							if (!state.videoFirstTried) state.videoFirstTried = {};
							const tried = state.videoFirstTried;

							target.click();
							target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

							// 校验导航成功（MCP 实测确认，2026-06）：
							//   ⚠️ 慕享 sidebar 跳转是「原地换内容」，URL 的 itemId 参数【不变】！
							//   只能用 sidebar 的 .current 是否切到 target 来判定导航成功。
							//   （旧思路用 itemId 变化校验会永远失败，误报 Vue 拦截。）
							let navigated = false;
							for (let w = 0; w < 5000; w += 500) {
								await $.sleep(500);
								if (!canRun()) return;
								if (target.classList.contains('current')) {
									navigated = true;
									break;
								}
							}
							if (!navigated) {
								// 点击未生效：标记该 dd 已试，避免反复点同一个无响应项卡死
								tried[targetTitle] = (tried[targetTitle] || 0) + 1;
								if (tried[targetTitle] >= 3) {
									$msg_and_log(
										'error',
										`视频优先：连续 3 次点击「${targetTitle}」未跳转，可能 Vue 拦截，跳过该视频（需手动检查）。`
									);
									// 跳过：直接回目录，交还 course 脚本
									await $.sleep(1500);
									history.back();
									return;
								}
								$msg_and_log('warn', `视频优先：点击「${targetTitle}」未跳转，重试中（第 ${tried[targetTitle]} 次）`);
								// 本次 main 结束；URL 没变 dispatcher 不会重入，但下次 course 重入或刷新会再触发
								return;
							}
							// 导航成功：sidebar 跳转是「原地换内容」，URL 不变 → dispatcher 不会重入！
							// 必须由本脚本自己重入 study.main 播放新视频（新 <video> 元素已替换）。
							$dbg(`videoFirst: 已跳转到「${targetTitle}」，主动重入 study.main 播放新视频`);
							// 先等新视频元素就绪（慕享替换 <video> 需要渲染时间），再重入
							await $.sleep(1500);
							if (!canRun()) return;
							// 自重入：复用同一 main，canRun 仍按 videoFirst 的 runAtUrl（/courseware2）判定。
							// 不动 dispatcher 状态——URL 没变，dispatcher 本就不会干扰。
							// 用 this.methods（this = 当前 Script 实例），避免引用 MoycpProject 触发循环类型推断。
							return (this.methods as any)?.main?.({
								canRun,
								job_id: state.current_job_id
							});
					}
					// sidebar 全 finish：Phase1 已完成（或重进恢复场景），落到下方「点去闯关」逻辑
					$dbg('videoFirst: sidebar 全部视频已完成，进入闯关（Phase2/恢复）');
					}

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
				// '/study?type=exam' 作为整体子串匹配不到。用 'type=exam'/'type=practice' 这个唯一标识。
				//
				// 同时匹配 exam 与 practice（MCP 实测确认，2026-06）：
				//   - exam（type=exam）：统一提交 button.submit → 出结算页 → 回目录
				//   - practice（type=practice）：逐题即时反馈，无 button.submit，由 practiceFinish 脚本
				//     点「完成」(div.btn.submit.finished) 收尾
				//   两种模式的答题面板/下一题按钮(.btn.next)结构一致，答题循环可共用 workAndExam，
				//   仅最后提交环节不同（见 moycp-work.ts 提交逻辑对 practice 的跳过处理）。
				//   若只匹配 exam，practice 页 82 题会晾着无人作答（历史 bug）。
				runAtUrl: { defaultValue: ['type=exam', 'type=practice'] }
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
					// ⚠️ worker 实例缓存（修复"点暂停无效"问题）。
					//
					// 根因：commonWork 控制面板的「暂停/继续」按钮在 onclick 里会【每次重新调用】
					// workerProvider()（见 utils/work.ts 的 controlBtn.onclick），而 workAndExam 内部
					// 每次 `new OCSWorker(...)`。若不缓存，点暂停时 workerProvider() 会创建一个全新空壳
					// worker，emit('stop') 发到空壳上，真正在答题循环里运行的 worker 收不到 → 暂停无效。
					//
					// 修复：首次调用（commonWork 启动答题，带 opts）创建并缓存；后续调用（暂停/继续按钮，
					// 无参）直接返回缓存的同一实例，让 emit 命中真实 worker。
					let _cachedWorker: ReturnType<typeof workAndExam> | null = null;
					commonWork(this, {
						workerProvider: (opts?: any) => {
							if (!_cachedWorker) {
								_cachedWorker = workAndExam(opts);
							}
							return _cachedWorker;
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
						// practice 模式答题结束后，主动触发练习完成脚本点「完成」收尾。
						//
						// ⚠️ 为什么需要主动触发：dispatcher 用单一 currentRunningScriptName 互斥锁，
						//   答题期间锁卡在 work（脚本遍历顺序 work 在 practiceFinish 前）。
						//   而 practice 页答完题 URL 不变 → dispatcher 不会清锁（仅 URL 变化才清）
						//   → practiceFinish 永远等不到锁，答完的「完成」按钮无人点。
						//   exam 模式无此问题（提交后出结算页→回目录，URL 会变）。
						//   这里复用 study→work 的主动触发模式兜底。互斥由 practiceFinish 内部
						//   的「等完成按钮」逻辑天然保证（按钮未出现它就空转）。
						if (location.search.includes('type=practice')) {
							const practiceScript = MoycpProject.scripts.practiceFinish;
							$dbg('流程: practice 答题结束，主动触发练习完成脚本');
							state.currentRunningScriptName = practiceScript.name;
							state.current_job_id = Math.random().toString(16).slice(2);
							practiceScript.methods?.main?.({
								canRun: () => urlMatches(practiceScript.cfg.runAtUrl as string[]),
								job_id: state.current_job_id
							});
						}
					}
					},
					start: start
				};
			},
			oncomplete() {
				// ⚠️ 关键修复：oncomplete 必须能自启动，不能只依赖 dispatcher。
				//
				// 框架的 getMatchedScripts 只在页面加载时执行一次。
				// - 用户【刷新】进入 type=exam/type=practice 页：框架匹配到本脚本，oncomplete 触发
				//   → 这里自启动 main（这正是"刷新就好"的原因）。
				// - 用户【从视频点去闯关 / 从目录点练习】SPA 跳转进来：框架不会重新匹配，
				//   oncomplete 不触发；此时由 study 脚本主动调用 work.main 兜底，
				//   同时 dispatcher 的 setInterval 也会尝试匹配。
				//
				// 三条路径中任意一条命中即可，state.currentRunningScriptName 做互斥，
				// 保证 work.main 只触发一次。
				if (urlMatches(['type=exam', 'type=practice']) && state.currentRunningScriptName !== this.name) {
					state.currentUrl = location.href;
					state.currentRunningScriptName = this.name;
					state.current_job_id = Math.random().toString(16).slice(2);
					this.methods?.main?.({
						canRun: () => urlMatches(['type=exam', 'type=practice']),
						job_id: state.current_job_id
					});
				}
			}
		}),
		/**
		 * 练习页「完成」按钮脚本
		 *
		 * practice 模式（examType=4, type=practice）与 exam 模式流程不同：
		 *   exam：全部答完→统一提交（button.submit）→出结算页→回目录（由 work 脚本接管）
		 *   practice：逐题答题，每题即时显示正确答案，最后一题点「完成」收尾（div.btn.submit.finished）
		 *
		 * 答题环节由 work 脚本统一承担（runAtUrl 同时匹配 type=exam 与 type=practice，
		 * 复用 workAndExam 逐题答题循环）。但 work 的统一提交对 practice 跳过（practice 无
		 * button.submit），所以练习答完后「完成」按钮仍无人点击。本脚本专门补这个缺口：
		 * 检测到「完成」按钮可见即点击，然后回目录页。
		 *
		 * ⚠️ 本脚本只负责 practice 的收尾点击，不参与答题/提交，与 work 答题逻辑互不影响。
		 * 选择器区别（MCP 实测确认）：
		 *   - exam 页提交按钮：button.submit（HTMLButtonElement）
		 *   - practice 页完成按钮：div.btn.submit.finished（HTMLDivElement，class 含 finished）
		 */
		practiceFinish: new Script({
			name: '✅ 练习完成脚本',
			namespace: 'moycp.practice-finish-v1',
			matches: [['练习页', 'moycp.com/study']],
			hideInPanel: false,
			configs: {
				runAtUrl: { defaultValue: ['type=practice'] }
			},
			methods() {
				return {
					main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
						$dbg('practice 脚本: 启动，等待「完成」按钮');
						// 等待练习页加载（答题面板出现）
						await waitForElement('.answer-panel-container, .answer-panel-content', { timeout_seconds: 15 });
						if (!canRun()) return;

						// 轮询等待「完成」按钮出现（practice 模式答到最后一题时才显示）
						// ⚠️ 双重条件，避免误点：
						//   1. .btn.submit.finished 存在（完成按钮就绪）
						//   2. 答题卡全部已答（.already 数 === 总数），防止中途短暂出现 finished 导致误点
						let finishBtn: HTMLElement | null = null;
						for (let w = 0; w < 60000; w += 1000) {
							if (!canRun()) return;
							finishBtn = document.querySelector<HTMLElement>('.btn.submit.finished');
							if (finishBtn) {
								const spans = document.querySelectorAll('.select-item-list span');
								const answered = document.querySelectorAll('.select-item-list span.already');
								// 答题卡为空（可能 Vue 未渲染）或全部已答时才确认
								if (spans.length === 0 || answered.length === spans.length) break;
							}
							await $.sleep(1000);
						}

						if (!finishBtn) {
							$dbg('practice 脚本: 60 秒内未检测到「完成」按钮，退出');
							return;
						}

						$dbg('practice 脚本: 检测到「完成」按钮，点击');
						await $.sleep(1500 + Math.random() * 1500); // 模拟人工延迟
						if (!canRun()) return;

						finishBtn.click();
						finishBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

						// 点击后等待页面响应。若慕享已自动跳转（URL 变化），则不强行导航，避免冲突。
						const urlBefore = location.href;
						await $.sleep(2500);
						if (!canRun()) return;

						if (location.href !== urlBefore) {
							$dbg('practice 脚本: 点击后慕享已自动跳转，不重复导航');
							return;
						}

						// 未自动跳转，则手动回目录页（复用 work 脚本的回退方式）
						const courseId = new URLSearchParams(location.search).get('courseId');
						$dbg(`practice 脚本: 已点击完成，回目录页 (courseId=${courseId || '无'})`);
						if (courseId) {
							location.href = `/courseDetail/catalog?courseId=${courseId}`;
						} else {
							history.back();
						}
					}
				};
			}
		})
	}
});

