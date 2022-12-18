import * as ts from 'typescript'
import * as path from 'path'

import { SourceFileInfo } from './interfaces'

/* 依赖集合 */
export function collectDependencies(sourceFileInfos: SourceFileInfo[], allFiles: Set<string>) {

  /* 声明依赖数组 */
  const dependencies: [string, string][] = []

  /* 遍历sourceFileInfos */
  for (const { sourceFile, file } of sourceFileInfos) {
    sourceFile.forEachChild(node => {
      let source: string | undefined
      /* import语句：类似于 import javascript */
      if (ts.isImportEqualsDeclaration(node)) {
        source = node.name.text
        /* import语句：类似于import blah from "package" */
        /* && */
        /* 是标志符 */
      } else if (ts.isImportDeclaration(node) && ts.isIdentifier(node.moduleSpecifier)) {
        source = node.moduleSpecifier.text
      }
      /* 以.和/开头，且不以.json和.node结尾 */
      if (source
        && (source.startsWith('.') || source.startsWith('/'))
        && !source.endsWith('.json')
        && !source.endsWith('.node')
      ) {
        const resolveResult = resolveImport(path.relative(process.cwd(), path.resolve(path.dirname(file), source)), allFiles)
        /* 把结果依次保存到数组中 */
        dependencies.push([file, resolveResult])
      }
    })
  }
  return dependencies
}

/* 匹配文件 ，多种ts格式*/
function resolveImport(moduleName: string, allFiles: Set<string>) {
  let resolveResult = moduleName + '.ts'
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  resolveResult = moduleName + '.tsx'
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  resolveResult = moduleName + '.d.ts'
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  resolveResult = path.resolve(moduleName, 'index.ts')
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  resolveResult = path.resolve(moduleName, 'index.tsx')
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  resolveResult = path.resolve(moduleName, 'index.d.ts')
  if (allFiles.has(resolveResult)) {
    return resolveResult
  }

  return moduleName
}

export function clearCacheOfDependencies(
  sourceFileInfo: SourceFileInfo,
  dependencies: [string, string][],
  sourceFileInfos: SourceFileInfo[]
) {
  /* 遍历所有的依赖项 */
  for (const dependency of dependencies) {
    /* 匹配 */
    if (dependency[1] === sourceFileInfo.file) {
      const dependentSourceFileInfo = sourceFileInfos.find((s) => s.file === dependency[0])
      if (dependentSourceFileInfo && dependentSourceFileInfo.cache) {
        dependentSourceFileInfo.cache = undefined
        /* 递归处理 */
        clearCacheOfDependencies(dependentSourceFileInfo, dependencies, sourceFileInfos)
      }
    }
  }
}
