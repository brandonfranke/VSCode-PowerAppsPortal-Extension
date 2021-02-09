import {
	CancellationToken,
	ProgressLocation,
	ProgressOptions,
	ProviderResult,
	QuickDiffProvider,
	QuickPickItem,
	Uri,
	window,
	workspace,
	WorkspaceFolder,
} from 'vscode';
import * as path from 'path';
import { ConfigurationManager } from '../configuration/configurationManager';
import { getFilename, PortalData, PortalFileType } from '../models/portalData';
import { DynamicsApi } from '../api/dynamicsApi';
import { ALL_FILES_GLOB, createFolder } from './afs';
import { WebTemplate } from '../models/WebTemplate';
import { ContentSnippet } from '../models/ContentSnippet';
import { getMimeType, WebFile } from '../models/WebFile';
import { ID365PortalLanguage } from '../models/interfaces/d365Language';
import { IPortalDataDocument } from '../models/interfaces/dataDocument';
import { ID365WebTemplate } from '../models/interfaces/d365WebTemplate';
import { ID365ContentSnippet } from '../models/interfaces/d365ContentSnippet';
import { ID365Note } from '../models/interfaces/d365Note';
import { WebPage } from '../models/webPage';
import { ID365Webpage } from '../models/interfaces/d365Webpage';
import { ID365PageTemplate } from '../models/interfaces/d365PageTemplate';

export const POWERAPPSPORTAL_SCHEME = 'powerappsPortal';
export const FOLDER_CONTENT_SNIPPETS = 'Content Snippets';
export const FOLDER_TEMPLATES = 'Web Templates';
export const FOLDER_WEB_FILES = 'Web Files';

export class PowerAppsPortalRepository implements QuickDiffProvider {
	private workspaceFolder: WorkspaceFolder;
	private configurationManager: ConfigurationManager;
	private d365WebApi: DynamicsApi;
	public portalName: string | undefined;
	public portalId: string | undefined;
	public defaultPageTemplate: string | undefined;

	private portalData: PortalData | undefined;
	public languages: Map<string, ID365PortalLanguage>;
	private isDownloadCanceled: boolean;

	constructor(workspaceFolder: WorkspaceFolder, configurationManager: ConfigurationManager) {
		this.workspaceFolder = workspaceFolder;
		this.configurationManager = configurationManager;
		this.d365WebApi = new DynamicsApi(this.configurationManager);
		this.languages = new Map<string, ID365PortalLanguage>();
		this.isDownloadCanceled = false;
	}

	provideOriginalResource(uri: Uri, token: CancellationToken | null): ProviderResult<Uri> {
		const relativePath = workspace.asRelativePath(uri.fsPath);
		return Uri.parse(`${POWERAPPSPORTAL_SCHEME}:${relativePath}`);
	}

	/**
	 * Enumerates the resources under source control.
	 */
	async provideSourceControlledResources(): Promise<Set<Uri>> {
		const result: Set<Uri> = new Set<Uri>();
		const resultPaths = new Set<string>();

		if (!this.portalData) {
			return result;
		}

		for (const template of this.portalData.data.webTemplate.values()) {
			const p = await this.createLocalResourcePath(template.name, PortalFileType.webTemplate, template);
			resultPaths.add(p);
		}

		for (const snippet of this.portalData.data.contentSnippet.values()) {
			// const f = Uri.file(this.createLocalResourcePath(snippet.name, PortalFileType.contentSnippet));
			const p = await this.createLocalResourcePath(snippet.name, PortalFileType.contentSnippet, snippet);
			resultPaths.add(p);
		}

		for (const file of this.portalData.data.webFile.values()) {
			// const f = Uri.file(this.createLocalResourcePath(file.d365Note.filename, PortalFileType.webFile));
			const p = await this.createLocalResourcePath(file.d365Note.filename, PortalFileType.webFile, file);
			resultPaths.add(p);
		}

		// iterate over all files currently in workspace folder.
		// this allows us to add files to the scm even if they haven't been tracked
		// by scm before
		const filesInFolder = await workspace.findFiles(ALL_FILES_GLOB);
		for (const f of filesInFolder) {
			if (!f) {
				console.error(`Could not track file.`);
				continue;
			}
			resultPaths.add(f.fsPath);
		}

		// prepare result
		for (const p of resultPaths) {
			result.add(Uri.file(p));
		}

		return result;
	}

	/**
	 * Creates a local file path in the local workspace that corresponds to the part of the
	 * file denoted by the given extension.
	 *
	 * @param extension file part, which is also used as a file extension
	 * @returns path of the locally cloned fiddle resource ending with the given extension
	 */
	async createLocalResourcePath(fileName: string, fileType: PortalFileType, portalDataFile?: IPortalDataDocument) {
		fileName = fileName.toLowerCase();
		let fileTypePath = '';
		switch (fileType) {
			case PortalFileType.contentSnippet:
				const filePath = fileName.split('/');
				fileName = filePath.pop() || fileName;
				// fileName = fileName.replace('/', '_');
				fileTypePath = FOLDER_CONTENT_SNIPPETS;
				const snippetPath = path.join(this.workspaceFolder.uri.fsPath, fileTypePath, ...filePath);
				try {
					await createFolder(snippetPath);
				} catch (error) {
					console.error(`Could not create folder ${snippetPath}`);
					throw Error(`Could not create folder ${snippetPath}`);
				}
				return path.join(snippetPath, fileName + '.html');

			case PortalFileType.webFile:
				fileTypePath = FOLDER_WEB_FILES;

				// should we create folders?
				if (this.configurationManager.useFoldersForWebFiles) {
					// get actual file
					const webFile = this.portalData?.data.webFile.get(fileName);

					if (webFile) {
						const webFilePath = path.join(this.workspaceFolder.uri.fsPath, fileTypePath, webFile.filePath);

						try {
							await createFolder(webFilePath);
						} catch (error) {
							console.error(`Could not create folder ${webFilePath}`);
							throw Error(`Could not create folder ${webFilePath}`);
						}

						return path.join(webFilePath, fileName);
					}
				}				

				return path.join(this.workspaceFolder.uri.fsPath, fileTypePath, fileName);

			case PortalFileType.webTemplate:
				fileTypePath = FOLDER_TEMPLATES;
				break;

			default:
				break;
		}
		return path.join(this.workspaceFolder.uri.fsPath, fileTypePath, fileName + '.html');
	}

	public async download(silent: boolean): Promise<PortalData> {
		const progressOptions: ProgressOptions = {
			location: silent ? ProgressLocation.SourceControl : ProgressLocation.Notification,
			title: 'Downloading',
			cancellable: true,
		};
		this.isDownloadCanceled = false;
		try {
			return window.withProgress(progressOptions, async (progress, token) => {
				token.onCancellationRequested(() => {
					this.isDownloadCanceled = true;
					console.log('User canceled the long running operation');
					return new PortalData(this.configurationManager.d365InstanceName || '', this.portalName || '');
				});

				let progressMessage = `Download: `;
				progress.report({
					message: progressMessage,
				});

				let portalId: string | undefined;
				if (!this.configurationManager.isPortalDataConfigured) {
					portalId = await this.choosePortal();
				} else {
					portalId = this.configurationManager.portalId;
					this.portalName = this.configurationManager.portalName;
					this.portalId = portalId;
					this.defaultPageTemplate = this.configurationManager.defaultPageTemplate;
				}

				if (!portalId) {
					console.error('[REPO] Could not get portal id either from existing configuration or from user.');
					return new PortalData(this.configurationManager.d365InstanceName || '', this.portalName || '');
				}

				progress.report({
					increment: 5,
				});

				const result = new PortalData(this.configurationManager.d365InstanceName || '', this.portalName || '');

				if (this.isDownloadCanceled) {
					return result;
				}

				if (this.languages.size === 0) {
					console.log('[REPO] Getting languages');

					let languages: Map<string, ID365PortalLanguage> = new Map<string, ID365PortalLanguage>();
					try {
						languages = await this.d365WebApi.getLanguages(portalId);
					} catch (error) {
						window.showErrorMessage(`Could not get portal data: ${error}`);
						return result;
					}

					if (languages.size === 0) {
						window.showWarningMessage(
							'Could not get any languages from portal. en-us will be set as the default.'
						);
					}

					this.languages = languages;

					console.log(`[REPO] Received ${this.languages.size} languages (not all of them active)`);
				}

				if (this.isDownloadCanceled) {
					return result;
				}
				progress.report({
					increment: 10,
				});

				let publishedStateId: string;
				if (this.portalData && this.portalData.publishedStateId) {
					publishedStateId = this.portalData.publishedStateId;
				} else {
					console.log(`[REPO] Download id of published state for portal`);
					publishedStateId = await this.d365WebApi.getPublishedPublishStateId(portalId);
					result.publishedStateId = publishedStateId;
				}

				if (this.isDownloadCanceled) {
					return result;
				}
				progressMessage += `${this.portalName}:`;
				progress.report({
					increment: 10,
					message: progressMessage + `… Templates `,
				});

				result.languages = this.languages;
				const webTemplates = await this.d365WebApi.getWebTemplates(portalId);

				if (this.isDownloadCanceled) {
					return result;
				}
				progressMessage += `✓ Templates: ${webTemplates.length}`;
				progress.report({
					increment: 20,
					message: progressMessage + `… Snippets `,
				});

				for (const template of webTemplates) {
					result.data.webTemplate.set(template.name.toLowerCase(), template);
				}

				const contentSnippets = await this.d365WebApi.getContentSnippets(portalId, this.languages);

				if (this.isDownloadCanceled) {
					return result;
				}
				progressMessage += `✓ Snippets: ${webTemplates.length}`;
				progress.report({
					increment: 25,
					message: progressMessage + `… Files `,
				});

				for (const snippet of contentSnippets) {
					const namePath = snippet.name.split('/');

					// insert language into name path e.g. 'Account/SignIn/PageCopy'
					// -> 'Account/SignIn/en-us/PageCopy'
					const name = [
						...namePath.slice(0, namePath.length - 1),
						snippet.language,
						namePath[namePath.length - 1],
					];
					result.data.contentSnippet.set(name.join('/').toLowerCase(), snippet);
				}

				if (this.isDownloadCanceled) {
					return result;
				}

				// get web pages				
				console.log('[REPO] Getting web pages');
				const webPageHierarchy = await this.d365WebApi.getWebPageHierarchy(portalId);
				result.webPages = webPageHierarchy;
				progress.report({
					increment: 5,
					message: progressMessage + `… Files `,
				});

				if (this.configurationManager.useFoldersForWebFiles && !this.configurationManager.defaultPageTemplate) {
					console.log('[REPO] default page template not set. Asking user.');
					
					// get default page template id
					this.defaultPageTemplate = await this.chooseDefaultWebTemplateId(portalId, undefined);
					console.log('[REPO] default page template id set: ' + this.defaultPageTemplate);
				}

				if (this.isDownloadCanceled) {
					return result;
				}
				const webFiles = await this.d365WebApi.getWebFiles(portalId, webPageHierarchy);
				for (const file of webFiles) {
					if (!file || !file.d365Note) {
						console.error(`Could not get a file.`);
					}
					result.data.webFile.set(file.d365Note.filename.toLowerCase(), file);
				}

				progressMessage += `✓ Files: ${webFiles.length} `;
				progress.report({
					increment: 25,
					message: progressMessage,
				});

				if (!silent) {
					window.showInformationMessage(progressMessage);
				}				

				this.portalData = result;
				return result;
			});
		} catch (error) {
			window.showErrorMessage('Could not download data: ' + error);
			throw new Error(error);
		}
	}

	public async deleteDocumentInRepository(fileType: PortalFileType, uri: Uri): Promise<void> {
		switch (fileType) {
			case PortalFileType.webTemplate:
				const t = this.portalData?.getWebTemplate(uri);
				if (!t) {
					throw Error('Could not find file in portal data with path ' + uri.fsPath);
				}
				await this.d365WebApi.deleteWebTemplate(t.id);
				this.portalData?.data.webTemplate.delete(t.name);
				break;

			case PortalFileType.contentSnippet:
				const s = this.portalData?.getContentSnippet(uri);
				if (!s) {
					throw Error('Could not find file in portal data with path ' + uri.fsPath);
				}
				await this.d365WebApi.deleteContentSnippet(s.id);
				this.portalData?.data.webTemplate.delete(s.name);
				break;

			case PortalFileType.webFile:
				const f = this.portalData?.getWebFile(uri);
				if (!f) {
					throw Error('Could not find file in portal data with path ' + uri.fsPath);
				}

				if (!f.d365File.adx_webfileid) {
					throw Error('Could not delete file because adx_webfileid was not defined.');
				}

				if (!f.d365Note.annotationid) {
					throw Error('Could not delete file because annotationid was not defined.');
				}

				try {
					await this.d365WebApi.deleteWebFile(f.d365File.adx_webfileid, f.d365Note.annotationid);
				} catch (error) {
					console.error('Could not delete file ' + f.d365Note.filename + ' Error: ' + error);
				}
				this.portalData?.data.webFile.delete(f.d365Note.filename);
				break;

			default:
				break;
		}
	}

	public async updateDocumentInRepository(
		fileType: PortalFileType,
		uri: Uri,
		updatedFileContent: string
	): Promise<void> {
		if (!this.portalData) {
			throw Error('Could not update file because portal data in repo class was not set.');
		}

		switch (fileType) {
			case PortalFileType.webTemplate:
				const existingTemplate = this.portalData.getWebTemplate(uri);
				const resultT = await this.updateWebTemplate(existingTemplate, updatedFileContent);
				if (resultT) {
					this.portalData.data.webTemplate.set(resultT.name, resultT);
					console.log(`\t[REPO] Template ${resultT.name} was updated.`);
				} else {
					throw new Error(`Could not find file for uri ${uri}`);
				}

				break;

			case PortalFileType.contentSnippet:
				const existingSnippet = this.portalData.getContentSnippet(uri);
				const resultS = await this.updateContentSnippet(existingSnippet, updatedFileContent);

				if (resultS) {
					this.portalData.data.contentSnippet.set(resultS.name, resultS);
					console.log(`\t[REPO] Snippet ${resultS.name} was updated.`);
				} else {
					throw new Error(`Could not find file for uri ${uri}`);
				}

				break;

			case PortalFileType.webFile:
				const existingFile = this.portalData.getWebFile(uri);
				const resultF = await this.updateWebFile(existingFile, updatedFileContent);

				if (resultF) {
					this.portalData.data.webFile.set(resultF.d365Note.filename, resultF);
					console.log(`\t[REPO] File ${resultF.d365Note.filename} was updated.`);
				} else {
					throw new Error(`Could not find file for uri ${uri}`);
				}

				break;

			default:
				break;
		}
	}

	private async updateWebTemplate(
		existingTemplate: WebTemplate | undefined,
		updatedFileContent: string
	): Promise<WebTemplate | undefined> {
		if (!existingTemplate) {
			return;
		}

		existingTemplate.source = updatedFileContent;
		return await this.d365WebApi.updateWebTemplate(existingTemplate);
	}

	private async updateContentSnippet(
		existingSnippet: ContentSnippet | undefined,
		updatedFileContent: string
	): Promise<ContentSnippet | undefined> {
		if (!existingSnippet) {
			return;
		}

		existingSnippet.source = updatedFileContent;
		return await this.d365WebApi.updateContentSnippet(existingSnippet);
	}

	private async updateWebFile(
		existingFile: WebFile | undefined,
		updatedFileContent: string
	): Promise<WebFile | undefined> {
		if (!existingFile) {
			return;
		}

		existingFile.b64Content = updatedFileContent;

		const updatedNote = await this.d365WebApi.updateFiles([existingFile.d365Note]);

		if (updatedNote.length > 0) {
			existingFile.d365Note = updatedNote[0];
			return existingFile;
		}

		throw Error(`Could not update file ${existingFile.d365File.adx_name}. Result set from dynamics was empty.`);
	}

	public async addDocumentToRepository(fileType: PortalFileType, uri: Uri, newFileContent: string) {
		if (!this.portalData) {
			throw Error('Could not update file because portal data in repo class was not set.');
		}

		const fileName = getFilename(uri, fileType);

		if (!this.portalId) {
			throw Error('Portal Id is not specified.');
		}
		switch (fileType) {
			case PortalFileType.webTemplate:
				const localNewTemplate: ID365WebTemplate = {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					_adx_websiteid_value: this.portalId,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_name: fileName,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_source: newFileContent,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_webtemplateid: undefined,
				};

				const remoteNewTemplate = await this.d365WebApi.addWebTemplate(localNewTemplate);
				this.portalData.data.webTemplate.set(remoteNewTemplate.name, remoteNewTemplate);
				console.log(`\t[REPO] Template ${remoteNewTemplate.name} was added.`);
				break;

			case PortalFileType.contentSnippet:
				const languageCode = this.portalData.getLanguageFromPath(uri);
				const localNewSnippet: ID365ContentSnippet = {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_name: fileName,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_value: newFileContent,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					_adx_contentsnippetlanguageid_value: languageCode,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_contentsnippetid: undefined,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					_adx_websiteid_value: this.portalId,
				};

				const remoteNewSnippet = await this.d365WebApi.addContentSnippet(localNewSnippet);
				this.portalData.data.contentSnippet.set(remoteNewSnippet.name, remoteNewSnippet);
				console.log(`\t[REPO] Snippet ${remoteNewSnippet.name} was added.`);
				break;

			case PortalFileType.webFile:
				if (!this.portalData.publishedStateId) {
					console.warn('Could not upload file because published state id is not defined.');
					this.portalData.publishedStateId = await this.d365WebApi.getPublishedPublishStateId(this.portalId);
				}

				const parentPage = await this.getWebFileLocation(uri, fileName);
				const localNewNote: ID365Note = {
					documentbody: newFileContent,
					filename: fileName,
					isdocument: true,
					annotationid: undefined,
					mimetype: getMimeType(fileName),
					// eslint-disable-next-line @typescript-eslint/naming-convention
					_objectid_value: undefined,
				};
				const remoteNewFile = await this.d365WebApi.uploadFile(
					localNewNote,
					this.portalId,
					parentPage.id,
					this.portalData.publishedStateId,
					parentPage
				);
				this.portalData.data.webFile.set(remoteNewFile.d365Note.filename, remoteNewFile);
				console.log(`\t[REPO] File ${remoteNewFile.d365Note.filename} was updated.`);
				break;

			default:
				break;
		}
	}

	public getPortalData(): PortalData {
		if (this.portalData) {
			return this.portalData;
		}

		return new PortalData(this.configurationManager.d365InstanceName || '', this.portalName || '');
	}

	private async choosePortal(): Promise<string | undefined> {
		let portals: Map<string, string>;
		try {
			portals = await this.d365WebApi.getPortals();
		} catch (error) {
			window.showErrorMessage(`Could not get portal data: ${error}`);
			return;
		}

		const portalChoice = await window.showQuickPick(new Array(...portals.keys()), {
			placeHolder: 'Select Portal',
			canPickMany: false,
			ignoreFocusOut: true,
		});

		if (!portalChoice) {
			return;
		}

		this.portalName = portalChoice;
		this.portalId = portals.get(portalChoice);
		return this.portalId;
	}

	private async chooseDefaultWebTemplateId(portalId: string, pageTemplates: Array<ID365PageTemplate> | undefined): Promise<string> {
		if (!pageTemplates) {
			try {
				pageTemplates = await this.d365WebApi.getPageTemplates(portalId);
			} catch (error) {
				window.showErrorMessage(`Could not get page template data: ${JSON.stringify(error)}`);
				return '';
			}
		}
		
		const pageTemplateChoices: QuickPickItem[] = pageTemplates.map((template) => {
			return {
				label: template.adx_name
			};
		});

		const webTemplateChoice = await window.showQuickPick(pageTemplateChoices, {
			canPickMany: false,
			ignoreFocusOut: true,
			placeHolder: 'Select a default page template which is used for new web file paths. Recommendation: \'Page\'. This setting only has an impact if folders for web files is enabled.',
		 });

		 const pickedTemplate = pageTemplates.find((t) => t.adx_name === webTemplateChoice?.label);
		 if (pickedTemplate) {
			 return pickedTemplate.adx_pagetemplateid;
		 }
		 window.showErrorMessage(`Could not get find id for page template. Please choose a different template.`);

		 return await this.chooseDefaultWebTemplateId(portalId, pageTemplates);
	}

	private async getWebFileLocation(uri: Uri, filename: string): Promise<WebPage> {
		// conventional approach (ask which web page to use as parent)
		if (!this.configurationManager.useFoldersForWebFiles) {
			return await this.chooseWebPage(filename);
		}


		// derive web page from uri
		const parentWebPage = this.portalData?.getWebPage(uri);

		if (parentWebPage) {
			return parentWebPage;
		}

		// web page does not exist (yet)
		console.log(`[REPO] Could not find preexisting web page for uri ${uri.fsPath}. Creating new web file(s).`);

		return await this.createPartialWebPagePath(uri);
	}

	private async createPartialWebPagePath(uri: Uri): Promise<WebPage> {
		const folders = path.dirname(uri.fsPath).split(path.sep);

		const webPagesToCreate: Array<Partial<ID365Webpage>> = new Array<Partial<ID365Webpage>>();

		// find first matching web page or root path

		while(folders.length > 0) {
			const currentWebPageName = folders[folders.length - 1];

			// stop if root is reached
			if (currentWebPageName === FOLDER_WEB_FILES) {
				const rootPage = this.portalData?.getRootWebPage();

				// could not find root page
				if(!rootPage) {
					break;
				}

				// set prev. last web page with root page
				const lastWebPage = webPagesToCreate[webPagesToCreate.length - 1];
				lastWebPage._adx_parentpageid_value = rootPage.id;
				break;				
			}

			let potentialWebPage = this.portalData?.getWebPageFromPartialFilePath(folders);

			// web page not found
			if (!potentialWebPage) {
				const toCreate: Partial<ID365Webpage> = {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_name: currentWebPageName, // eslint-disable-next-line @typescript-eslint/naming-convention
					adx_partialurl: currentWebPageName, // eslint-disable-next-line @typescript-eslint/naming-convention		
					_adx_pagetemplateid_value: this.configurationManager.defaultPageTemplate, // eslint-disable-next-line @typescript-eslint/naming-convention					
					_adx_publishingstateid_value: this.portalData?.publishedStateId, // eslint-disable-next-line @typescript-eslint/naming-convention
					_adx_parentpageid_value: undefined, // eslint-disable-next-line @typescript-eslint/naming-convention
					_adx_websiteid_value: this.portalId,// eslint-disable-next-line @typescript-eslint/naming-convention
					adx_hiddenfromsitemap: true
				};
				webPagesToCreate.push(toCreate);
			} else {
				const lastWebPage = webPagesToCreate[webPagesToCreate.length - 1];
				if (lastWebPage) {
					lastWebPage._adx_parentpageid_value = potentialWebPage.id;
					break;
				}				
			}

			folders.pop();
		}

		// constructed web page hierarchy finished
		let prevParentId: string | undefined = webPagesToCreate[webPagesToCreate.length - 1]?._adx_parentpageid_value;
		let lastWebPage: WebPage | undefined;
		while(webPagesToCreate.length > 0) {
			const webPageToCreate = webPagesToCreate.pop();

			if (!webPageToCreate) {
				break;
			}

			if (prevParentId) {
				webPageToCreate._adx_parentpageid_value = prevParentId;
			}

			let newWebPage: ID365Webpage | undefined;
			try {
				newWebPage = await this.d365WebApi.createWebPage(webPageToCreate);
			} catch (error) {
				window.showErrorMessage(`Could not create partial web page path element ${webPageToCreate.adx_partialurl}. Error: ${JSON.stringify(error)}`);
				throw error;
			}

			console.log('[REPO] Created web page: ' + newWebPage.adx_name);
			prevParentId = newWebPage.adx_webpageid;
			lastWebPage = WebPage.addWebPagesToPageHierarchy(this.portalData?.webPages || new Map<string, WebPage>(), newWebPage);;
		}

		if (!lastWebPage) {
			throw Error('Could not create web pages to upload web files. Please try to create a file path hierarchy in Dynamics first.');
		}

		return lastWebPage;
	}

	private async chooseWebPage(fileName: string): Promise<WebPage> {
		if (!this.portalData) {
			throw Error('Could not choose web page because portal data in repo class was not set.');
		}

		if (!this.portalId) {
			throw Error('Could not choose web page because portal Id is not specified.');
		}

		if (this.portalData.webPages.size === 0) {
			console.log('[REPO] Uploading file but no web pages to choose from. Downloading web pages.');
			this.portalData.webPages = await this.d365WebApi.getWebPageHierarchy(this.portalId);

			// no result
			if (this.portalData.webPages.size === 0) {
				throw Error(
					'[REPO] Could not get web pages from portal. Result set is empty. Please make sure the portal has web pages.'
				);
			}
		}
		const webPagesFlatList = new Array<WebPage>(...this.portalData.webPages.values());
		const webPageNames: Array<QuickPickItem> = webPagesFlatList.map((webPage) => {
			const item: QuickPickItem = {
				label: webPage.name,
				description: `${webPage.getFullPath()}/${fileName}`,
			};
			return item;
		});
		const webPageChoice = await window.showQuickPick(webPageNames, {
			ignoreFocusOut: true,
			placeHolder: 'Choose parent page for file ' + fileName,
		});

		if (!webPageChoice) {
			return await this.chooseWebPage(fileName);
		}

		// resolve id
		const result = webPagesFlatList.find((webpage) => webpage.name === webPageChoice.label);

		if (!result) {
			return await this.chooseWebPage(fileName);
		}

		return result;
	}
}
