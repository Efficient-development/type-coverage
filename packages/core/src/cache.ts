import * as path from 'path'
import * as fs from 'fs'
import { promisify } from 'util'
import { createHash } from 'crypto'

import { TypeCheckResult } from './interfaces'

const readFileAsync = promisify(fs.readFile)  
const writeFileAsync = promisify(fs.writeFile)
const mkdirAsync = promisify(fs.mkdir)

/* 获取文件哈希值 */
export async function getFileHash(file: string, enableCache: boolean) {
  return enableCache ? calculateHash((await readFileAsync(file)).toString()) : ''
}

function calculateHash(str: string): string {
  /* 根据字符串（文件内容）来进行sha1哈希计算 */
  return createHash('sha1').update(str).digest('hex')
}

export async function saveCache(typeCheckResult: TypeCheckResult, dirName = defaultDirName) {
  /* 创建文件目录 */
  await mkdirIfmissing(dirName)
  /* 写数据到JSON文件中 */
  await writeFileAsync(path.resolve(dirName, 'result.json'), JSON.stringify(typeCheckResult, null, 2))
}

const defaultDirName = '.type-coverage'

/* 异步检测文件状态 */
function statAsync(p: string) {
  return new Promise<fs.Stats | undefined>((resolve) => {
    fs.stat(p, (err, stats) => {
      if (err) {
        resolve(undefined)
      } else {
        resolve(stats)
      }
    })
  })
}


/* 如果目标文件夹不存在那就创建 */
async function mkdirIfmissing(dirName = defaultDirName) {
  const stats = await statAsync(dirName)
  if (!stats) {
    await mkdirAsync(dirName, { recursive: true })
  }
}

/* 读取缓存数据 */
export async function readCache(enableCache: boolean, dirName = defaultDirName): Promise<TypeCheckResult> {
  if (!enableCache) {
    return {
      cache: {}
    }
  }
  /* 拼接路径 */
  const filepath = path.resolve(dirName, 'result.json')
  /* 检查文件状态 */
  const stats = await statAsync(filepath)
  /* 如果是文件，那就读取文件的内容 */
  if (stats && stats.isFile()) {
    const text = (await readFileAsync(filepath)).toString()
    /* 把JSON数据解析为缓存对象 */
    const typeCheckResult = JSON.parse(text) as TypeCheckResult
    if (typeCheckResult && Array.isArray(typeCheckResult.cache)) {
      typeCheckResult.cache = {}
    }
    return typeCheckResult
  }
  return {
    cache: {}
  }
}
