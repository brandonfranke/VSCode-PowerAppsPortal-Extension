/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { utils } from 'mocha';
import {
	QuickPickItem,
	window,
	Disposable,
	CancellationToken,
	QuickInputButton,
	QuickInput,
	ExtensionContext,
	QuickInputButtons,
	Uri,
} from 'vscode';
import { Utils } from '../utils';

export interface ConfigurationState {
	instanceName: string;
	crmRegion: QuickPickItem | string;
	aadClientId: string;
	aadClientSecret: string;
	aadTenantId: string;
}

export async function multiStepInput(context: ExtensionContext): Promise<ConfigurationState>  {

	const crmRegions: QuickPickItem[] = [
		{label: 'crm', description: 'North America'},
		{label: 'crm2', description: 'South America'},
		{label: 'crm3', description: 'Canada'},
		{label: 'crm4', description: 'EMEA'},
		{label: 'crm5', description: 'APAC'},
		{label: 'crm6', description: 'Australia'},
		{label: 'crm7', description: 'Japan'},
		{label: 'crm8', description: 'India'},
		{label: 'crm9', description: 'North America 2'},
		{label: 'crm11', description: 'UK'}
	];

	


	async function collectInputs() {
		const state = {} as Partial<ConfigurationState>;
		await MultiStepInput.run((input) => inputInstanceName(input, state));
		return state as ConfigurationState;
	}

	const title = 'Connect to your instance';

	async function inputInstanceName(input:MultiStepInput, state: Partial<ConfigurationState>) {
		const additionalSteps = typeof state.instanceName === 'string' ? 1 : 0;
		// TODO: Remember current value when navigating back.
		state.instanceName = await input.showInputBox({
			title,
			step: 2 + additionalSteps,
			totalSteps: 3 + additionalSteps,
			value: state.instanceName || '',
			prompt: 'Provide the name of your instance. E.g. org7acas9gc if the url to your org is org7c98f08c.crm4.dynamics.com',
			validate: noValidation,
			shouldResume: shouldResume,
		});
		return (input: MultiStepInput) => pickEmeaRegion(input, state);
	}

	async function pickEmeaRegion(input: MultiStepInput, state: Partial<ConfigurationState>) {
		const pick = await input.showQuickPick({
			title,
			step: 1,
			totalSteps: 5,
			placeholder: 'Select your portal region',
			items: crmRegions,
			activeItem: typeof state.crmRegion !== 'string' ? state.crmRegion : undefined,
			shouldResume: shouldResume,
		});
		
		state.crmRegion = pick;
		return (input: MultiStepInput) => inputTenantId(input, state);
	}

	async function inputTenantId(input:MultiStepInput, state: Partial<ConfigurationState>) {
		const additionalSteps = typeof state.aadTenantId === 'string' ? 1 : 0;

		state.aadTenantId = await input.showInputBox({
			title,
			step: 2 + additionalSteps,
			totalSteps: 3 + additionalSteps,
			value: state.aadTenantId || '',
			prompt: 'Provide the tenant Id of your AAD instance e.g. 10ea4d3e-1511-4461-9c6d-e21e73840528',
			validate: validateGuid,
			shouldResume: shouldResume,
		});
		return (input: MultiStepInput) => inputClientId(input, state);
	}


	async function inputClientId(input:MultiStepInput, state: Partial<ConfigurationState>) {
		const additionalSteps = typeof state.aadClientId === 'string' ? 1 : 0;

		state.aadClientId = await input.showInputBox({
			title,
			step: 2 + additionalSteps,
			totalSteps: 3 + additionalSteps,
			value: state.aadClientId || '',
			prompt: 'Provide the client Id of your AAD app registration e.g. 65f4ee4c-bbec-4059-b2ce-05e8e8acc679',
			validate: validateGuid,
			shouldResume: shouldResume,
		});
		return (input: MultiStepInput) => inputClientSecret(input, state);
	}

	async function inputClientSecret(input:MultiStepInput, state: Partial<ConfigurationState>) {
		const additionalSteps = typeof state.aadClientSecret === 'string' ? 1 : 0;

		state.aadClientSecret = await input.showInputBox({
			title,
			step: 2 + additionalSteps,
			totalSteps: 3 + additionalSteps,
			value: state.aadClientSecret || '',
			prompt: 'Provide the client secret',
			validate: noValidation,
			shouldResume: shouldResume,
		});		
	}


	function shouldResume() {
		// Could show a notification with the option to resume.
		return new Promise<boolean>((resolve, reject) => {
			// noop
		});
	}

	async function validateGuid(name:string) {
		return !Utils.isGuid(name) ? 'Guid not valid' : undefined;
	}

	async function noValidation(name:string): Promise<string | undefined> {
		return undefined;
	}

	const state = await collectInputs();
	return state;
}

// -------------------------------------------------------
// Helper code that wraps the API for the multi-step case.
// -------------------------------------------------------

class InputFlowAction {
	static back = new InputFlowAction();
	static cancel = new InputFlowAction();
	static resume = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface QuickPickParameters<T extends QuickPickItem> {
	title: string;
	step: number;
	totalSteps: number;
	items: T[];
	activeItem?: T;
	placeholder: string;
	buttons?: QuickInputButton[];
	shouldResume: () => Thenable<boolean>;
}

interface InputBoxParameters {
	title: string;
	step: number;
	totalSteps: number;
	value: string;
	prompt: string;
	validate: (value: string) => Promise<string | undefined>;
	buttons?: QuickInputButton[];
	shouldResume: () => Thenable<boolean>;
}

class MultiStepInput {
	static async run<T>(start: InputStep) {
		const input = new MultiStepInput();
		return input.stepThrough(start);
	}

	private current?: QuickInput;
	private steps: InputStep[] = [];

	private async stepThrough<T>(start: InputStep) {
		let step: InputStep | void = start;
		while (step) {
			this.steps.push(step);
			if (this.current) {
				this.current.enabled = false;
				this.current.busy = true;
			}
			try {
				step = await step(this);
			} catch (err) {
				if (err === InputFlowAction.back) {
					this.steps.pop();
					step = this.steps.pop();
				} else if (err === InputFlowAction.resume) {
					step = this.steps.pop();
				} else if (err === InputFlowAction.cancel) {
					step = undefined;
				} else {
					throw err;
				}
			}
		}
		if (this.current) {
			this.current.dispose();
		}
	}

	async showQuickPick<T extends QuickPickItem, P extends QuickPickParameters<T>>({
		title,
		step,
		totalSteps,
		items,
		activeItem,
		placeholder,
		buttons,
		shouldResume,
	}: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<T | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createQuickPick<T>();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.placeholder = placeholder;
				input.items = items;
				if (activeItem) {
					input.activeItems = [activeItem];
				}
				input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : []), ...(buttons || [])];
				disposables.push(
					input.onDidTriggerButton((item) => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidChangeSelection((items) => resolve(items[0])),
					input.onDidHide(() => {
						(async () => {
							reject(
								shouldResume && (await shouldResume()) ? InputFlowAction.resume : InputFlowAction.cancel
							);
						})().catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach((d) => d.dispose());
		}
	}

	async showInputBox<P extends InputBoxParameters>({
		title,
		step,
		totalSteps,
		value,
		prompt,
		validate,
		buttons,
		shouldResume,
	}: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createInputBox();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.value = value || '';
				input.prompt = prompt;
				input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : []), ...(buttons || [])];
				let validating = validate('');
				disposables.push(
					input.onDidTriggerButton((item) => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidAccept(async () => {
						const value = input.value;
						input.enabled = false;
						input.busy = true;
						if (!(await validate(value))) {
							resolve(value);
						}
						input.enabled = true;
						input.busy = false;
					}),
					input.onDidChangeValue(async (text) => {
						const current = validate(text);
						validating = current;
						const validationMessage = await current;
						if (current === validating) {
							input.validationMessage = validationMessage;
						}
					}),
					input.onDidHide(() => {
						(async () => {
							reject(
								shouldResume && (await shouldResume()) ? InputFlowAction.resume : InputFlowAction.cancel
							);
						})().catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach((d) => d.dispose());
		}
	}
}
