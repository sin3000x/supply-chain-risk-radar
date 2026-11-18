import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const defaultBaseUrl = 'https://api.openai.com/v1';
const defaults = {
  baseUrl:process.env.DEEPSEEK_BASE_URL || (process.env.DEEPSEEK_API_KEY
    ? 'https://api.deepseek.com' : defaultBaseUrl),
  modelId:process.env.DEEPSEEK_MODEL || (process.env.DEEPSEEK_API_KEY ? 'deepseek-flash' : ''),
  apiKey:process.env.DEEPSEEK_API_KEY || '',
};

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username || url.password || url.search || url.hash) {
    throw Error('Base URL 必须是 HTTP 或 HTTPS 地址。');
  }
  return url.href.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
}

export function canUseModel(profile) {
  return Boolean(profile?.modelId && (profile.apiKey || new URL(profile.baseUrl).protocol === 'http:'));
}

export async function openModelSettings(path = process.env.MODEL_CONFIG_PATH ||
  fileURLToPath(new URL('./var/model-settings.json',import.meta.url))) {
  let current;
  try {
    current = JSON.parse(await readFile(path,'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = defaults;
  }
  if (current.version !== 2) {
    // The old file held a single configuration. Preserve it and its key when opening it.
    const {baseUrl,modelId,apiKey} = current;
    const profile = {id:'default',name:modelId || '默认配置',baseUrl:normalizeBaseUrl(baseUrl),modelId,apiKey};
    current = {version:2,activeId:canUseModel(profile) ? profile.id : null,profiles:[profile]};
  }
  let queue = Promise.resolve();

  function describe() {
    return {
      protocol:'openai-compatible', defaultBaseUrl, activeId:current.activeId,
      profiles:current.profiles.map(({id,name,baseUrl,modelId,apiKey}) => ({
        id,name,baseUrl,modelId,hasApiKey:Boolean(apiKey),ready:canUseModel({baseUrl,modelId,apiKey}),
      })),
    };
  }

  async function save(input) {
    if (!input || typeof input !== 'object') throw Error('请检查模型配置。');
    let next;
    let profileId;
    if (input.action === 'activate') {
      const profile = current.profiles.find(item => item.id === input.id);
      if (input.id !== null && !canUseModel(profile)) throw Error('请先保存完整的模型配置。');
      if (current.activeId === input.id) return describe();
      next = {...current,activeId:input.id};
    } else if (input.action === 'save') {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 ||
          typeof input.baseUrl !== 'string' || input.baseUrl.length > 500 ||
          typeof input.modelId !== 'string' || input.modelId.length > 200 ||
          typeof input.apiKey !== 'string' || input.apiKey.length > 4096) {
        throw Error('请检查配置名、Base URL、API Key 和 Model ID。');
      }
      const existing = current.profiles.find(profile => profile.id === input.id);
      if (input.id !== null && !existing) throw Error('找不到要编辑的模型配置。');
      if (!existing && current.profiles.length >= 50) throw Error('最多可保存 50 套模型配置。');
      let baseUrl;
      try {
        baseUrl = normalizeBaseUrl(input.baseUrl.trim());
      } catch {
        throw Error('请输入有效的 HTTP 或 HTTPS Base URL。');
      }
      const apiKey = input.apiKey.trim();
      if (apiKey && /[^!-~]/.test(apiKey)) throw Error('API Key 不能包含空格或换行。');
      profileId = existing?.id ?? randomUUID();
      const profile = {id:profileId,name:input.name.trim(),baseUrl,modelId:input.modelId.trim(),
        apiKey:input.clearKey ? '' : apiKey || (baseUrl === existing?.baseUrl ? existing.apiKey : '')};
      const profiles = existing ? current.profiles.map(item => item.id === profileId ? profile : item)
        : [...current.profiles,profile];
      const activeId = current.activeId === profileId && !canUseModel(profile) ? null : current.activeId;
      next = {...current,activeId,profiles};
    } else throw Error('不支持的配置操作。');

    const temporary = path+'.'+randomUUID()+'.tmp';
    await mkdir(dirname(path),{recursive:true});
    try {
      await writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});
      await rename(temporary,path);
    } finally {
      await rm(temporary,{force:true}).catch(()=>{});
    }
    current = next;
    return {...describe(),profileId};
  }

  return {
    read:() => current.profiles.find(profile => profile.id === current.activeId),
    describe,
    update(input) {
      const result = queue.then(()=>save(input));
      queue = result.catch(()=>{});
      return result;
    },
  };
}
