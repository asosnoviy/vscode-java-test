// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { ClassPathManager } from '../classPathManager';
import { TestStatusBarProvider } from '../testStatusBarProvider';
import * as Configs from '../Constants/configs';
import { TestKind, TestLevel, TestResult, TestStatus, TestSuite } from '../Models/protocols';
import { RunConfigItem } from '../Models/testConfig';
import * as Logger from '../Utils/Logger/logger';
import { ITestResult } from './testModel';
import { ITestRunner } from './testRunner';
import { ITestRunnerParameters } from './testRunnerParameters';
import { JUnitTestRunner } from './JUnitTestRunner/junitTestRunner';

import * as cp from 'child_process';
import * as kill from 'tree-kill';
import { window, EventEmitter } from 'vscode';

export class TestRunnerWrapper {
    public static registerRunner(kind: TestKind, runner: ITestRunner) {
        TestRunnerWrapper.runnerPool.set(kind, runner);
    }

    public static async run(tests: TestSuite[], isDebugMode: boolean, config: RunConfigItem): Promise<void> {
        if (TestRunnerWrapper.running) {
            window.showInformationMessage('A test session is currently running. Please wait until it finishes.');
            Logger.info('Skip this run cause we only support running one session at the same time');
            return;
        }
        TestRunnerWrapper.running = true;
        try {
            const runners: Map<ITestRunner, TestSuite[]> = TestRunnerWrapper.classifyTests(tests);
            await TestStatusBarProvider.getInstance().update(tests, (async () => {
                for (const [runner, t] of runners.entries()) {
                    if (config && config.preLaunchTask.length > 0) {
                        try {
                            this.preLaunchTask = cp.exec(
                                config.preLaunchTask, {
                                    maxBuffer: Configs.CHILD_PROCESS_MAX_BUFFER_SIZE,
                                    cwd: config.workingDirectory,
                                });
                            await this.execPreLaunchTask();
                        } finally {
                            this.preLaunchTask = undefined;
                        }
                    }
                    const params = await runner.setup(t, isDebugMode, config);
                    await runner.run(params).then(async (res) => {
                        this.updateTestStorage(t, res);
                        await runner.postRun();
                    }, async ([error, res]) => {
                        this.updateTestStorage(t, res);
                        await runner.postRun();
                        throw error;
                    });
                }
            })());
        } finally {
            TestRunnerWrapper.running = false;
        }
    }

    public static async cancel(): Promise<void> {
        if (this.preLaunchTask) {
            return new Promise<void>((resolve, reject) => {
                kill(this.preLaunchTask.pid, 'SIGTERM', (err) => {
                    if (err) {
                        Logger.error('Failed to cancel this prelaunch task.', {
                            error: err,
                        });
                        return reject(err);
                    }
                    resolve();
                });
            });
        } else {
            const tasks: Array<Promise<void>> = [];
            TestRunnerWrapper.runnerPool.forEach((runner) => tasks.push(runner.cancel()));
            await Promise.all(tasks);
            return Promise.resolve();
        }
    }

    private static readonly runnerPool: Map<TestKind, ITestRunner> = new Map<TestKind, ITestRunner>();
    private static running: boolean = false;
    private static preLaunchTask: cp.ChildProcess;

    private static classifyTests(tests: TestSuite[]): Map<ITestRunner, TestSuite[]> {
        return tests.reduce((map, t) => {
            const runner = this.getRunner(t);
            if (runner === null) {
                Logger.warn(`Cannot find matched runner to run the test: ${t.test}`, {
                    test: t,
                });
                return map;
            }
            const collection: TestSuite[] = map.get(runner);
            if (!collection) {
                map.set(runner, [t]);
            } else {
                collection.push(t);
            }
            return map;
        }, new Map<ITestRunner, TestSuite[]>());
    }

    private static getRunner(test: TestSuite): ITestRunner {
        if (!TestRunnerWrapper.runnerPool.has(test.kind)) {
            return null;
        }
        return TestRunnerWrapper.runnerPool.get(test.kind);
    }

    private static updateTestStorage(tests: TestSuite[], result: ITestResult[]): void {
        const mapper = result.reduce((total, cur) => {
            total.set(cur.test, cur.result);
            return total;
        }, new Map<string, TestResult>());
        const classesInflucenced = [];
        const flattenedTests = new Set(tests.map((t) => [t, t.parent, ...(t.children || [])])
                                    .reduce((total, cur) => total.concat(cur), [])
                                    .filter((t) => t));
        flattenedTests.forEach((t) => {
            if (mapper.has(t.test)) {
                t.result = mapper.get(t.test);
            } else if (t.level === TestLevel.Class) {
                classesInflucenced.push(t);
            }
        });
        classesInflucenced.forEach((c) => this.processClass(c));
    }

    private static processClass(t: TestSuite): void {
        let passNum: number = 0;
        let failNum: number = 0;
        let skipNum: number = 0;
        let duration: number = 0;
        let notRun: boolean = false;
        for (const child of t.children) {
            if (!child.result) {
                notRun = true;
                continue;
            }
            duration += Number(child.result.duration);
            switch (child.result.status) {
                case TestStatus.Pass:
                    passNum++;
                    break;
                case TestStatus.Fail:
                    failNum++;
                    break;
                case TestStatus.Skipped:
                    skipNum++;
                    break;
            }
        }

        t.result = {
            status: notRun ? undefined : (skipNum === t.children.length ? TestStatus.Skipped : (failNum > 0 ? TestStatus.Fail : TestStatus.Pass)),
            summary: `Tests run: ${passNum + failNum}, Failures: ${failNum}, Skipped: ${skipNum}.`,
            duration: notRun ? undefined : duration.toString(),
        };
    }

    private static execPreLaunchTask(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.preLaunchTask.on('error', (err) => {
                Logger.error(
                    `Error occurred while executing prelaunch task.`,
                    {
                        name: err.name,
                        message: err.message,
                        stack: err.stack,
                    });
                reject(err);
            });
            this.preLaunchTask.stderr.on('data', (data) => {
                Logger.error(`Error occurred: ${data.toString()}`);
            });
            this.preLaunchTask.stdout.on('data', (data) => {
                Logger.info(data.toString());
            });
            this.preLaunchTask.on('close', (signal) => {
                if (signal && signal !== 0) {
                    reject(`Prelaunch task exited with code ${signal}.`);
                } else {
                    resolve(signal);
                }
            });
        });
    }
}
