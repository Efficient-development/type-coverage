import * as ts from 'typescript'
import * as path from 'path'
import minimatch = require('minimatch')
import { getProjectRootNamesAndCompilerOptions } from './tsconfig'

import {
  FileContext,
  AnyInfo,
  SourceFileInfo,
  LintOptions,
  FileTypeCheckResult,
  SourceFileInfoWithoutCache,
  FileAnyInfoKind
} from './interfaces'
import { checkNode } from './checker'
import { clearCacheOfDependencies, collectDependencies } from './dependencies'
import { collectIgnoreMap } from './ignore'
import { readCache, getFileHash, saveCache } from './cache'

/**
 * @public
 * 核心函数：主流程
 */
export async function lint(project: string, options?: Partial<LintOptions>) {
  /* 检测的前置条件(参数) */
  const lintOptions = { ...defaultLintOptions, ...options }
  
  /* 获取项目的根目录和编译选项 */
  const { rootNames, compilerOptions } = await getProjectRootNamesAndCompilerOptions(project)

  /* 通过ts创建处理程序 */
  const program = ts.createProgram(rootNames, compilerOptions, undefined, lintOptions.oldProgram)

  /* 获取类型检查器 */
  const checker = program.getTypeChecker()

  /* 声明用于保存文件的集合 */
  const allFiles = new Set<string>()
  /* 声明用于保存文件信息的数组 */
  const sourceFileInfos: SourceFileInfo[] = []
  /* 根据配置参数从缓存中读取类型检查结果（缓存的数据） */
  const typeCheckResult = await readCache(lintOptions.enableCache, lintOptions.cacheDirectory)
  /* 读取配置参数中的忽略文件信息 */
  const ignoreFileGlobs = lintOptions.ignoreFiles
    ? (typeof lintOptions.ignoreFiles === 'string'
      ? [lintOptions.ignoreFiles]
      : lintOptions.ignoreFiles)
    : undefined
  
  /* 获取所有的SourceFiles并遍历 */
  for (const sourceFile of program.getSourceFiles()) {
    let file = sourceFile.fileName
    if (!file.includes('node_modules')) {
      /* 如果不是绝对路径 */
      if (!lintOptions.absolutePath) {
        /* process.cwd() 是当前Node进程执行时的文件夹地址，也就是工作目录，保证了文件在不同的目录下执行时，路径始终不变 */
        /* __dirname 是被执行的js文件的地址，也就是文件所在目录 */
        /* 计算得到文件的相对路径 */
        file = path.relative(process.cwd(), file)
        /* 如果路径以..开头则跳过该文件 */
        if (file.startsWith('..')) {
          continue
        }
      }
      /* 如果lintOptions.files中不包含该文件，则跳过 */
      if (lintOptions.files && !lintOptions.files.includes(file)) {
        continue
      }
      /* 如果该文件存在于忽略配置项中，则跳过 */
      if (ignoreFileGlobs && ignoreFileGlobs.some((f) => minimatch(file, f))) {
        continue
      }
      /* 添加文件到集合 */
      allFiles.add(file)

      /* 计算文件的哈希值 */
      const hash = await getFileHash(file, lintOptions.enableCache)

      /* 检查该文件是否存在缓存数据 */
      const cache = typeCheckResult.cache[file]

      /* 如果存在缓存数据 */
      if (cache) {
        /* 如果配置项定义了ignoreNested 则忽略 嵌套的any */
        if (lintOptions.ignoreNested) {
          cache.anys = cache.anys.filter((c) => c.kind !== FileAnyInfoKind.containsAny)
        }
         /* 如果配置项定义了ignoreAsAssertion 则忽略 不安全的as */
        if (lintOptions.ignoreAsAssertion) {
          cache.anys = cache.anys.filter((c) => c.kind !== FileAnyInfoKind.unsafeAs)
        }
        /* 如果配置项定义了ignoreTypeAssertion 则忽略 不安全的类型断言 */
        if (lintOptions.ignoreTypeAssertion) {
          cache.anys = cache.anys.filter((c) => c.kind !== FileAnyInfoKind.unsafeTypeAssertion)
        }
         /* 如果配置项定义了ignoreNonNullAssertion 则忽略 不安全的非空断言 */
        if (lintOptions.ignoreNonNullAssertion) {
          cache.anys = cache.anys.filter((c) => c.kind !== FileAnyInfoKind.unsafeNonNull)
        }
      }

      /* 更新sourceFileInfos对象数组 */
      sourceFileInfos.push({
        file, /* 文件路径 */
        sourceFile,
        hash,/* 哈希值 */
        cache: cache && cache.hash === hash ? cache : undefined /* 该文件的缓存信息 */
      })
    }
  }

  /* 如果启用了缓存 */
  if (lintOptions.enableCache) {
    /* 获取依赖集合 */
    const dependencies = collectDependencies(sourceFileInfos, allFiles)

    /* 遍历sourceFileInfos */
    for (const sourceFileInfo of sourceFileInfos) {
      /* 如果没有使用缓存，那就清理依赖 */
      if (!sourceFileInfo.cache) {
        clearCacheOfDependencies(sourceFileInfo, dependencies, sourceFileInfos)
      }
    }
  }

  let correctCount = 0
  let totalCount = 0

  /* 声明anys数组 */
  const anys: AnyInfo[] = []
  /* 声明fileCounts映射 */
  const fileCounts =
    new Map<string, Pick<FileTypeCheckResult, 'correctCount' | 'totalCount'>>()

/* 遍历sourceFileInfos */
  for (const { sourceFile, file, hash, cache } of sourceFileInfos) {
    /* 如果存在缓存，那么直接根据缓存处理后就跳过 */
    if (cache) {
      /* 累加correctCount和totalCount */
      correctCount += cache.correctCount
      totalCount += cache.totalCount

      /* 把缓存的anys合并到anys数据中 */
      anys.push(...cache.anys.map((a) => ({ file, ...a })))

      if (lintOptions.fileCounts) {
        /* 统计每个文件的数据 */
        fileCounts.set(file, {
          correctCount: cache.correctCount,
          totalCount: cache.totalCount,
        })
      }
      continue
    }

    /* 获取忽略的集合 */
    const ingoreMap = collectIgnoreMap(sourceFile, file)

    /* 组织上下文对象 */
    const context: FileContext = {
      file,
      sourceFile,
      typeCheckResult: {
        correctCount: 0,
        totalCount: 0,
        anys: []
      },
      ignoreCatch: lintOptions.ignoreCatch,
      ignoreUnreadAnys: lintOptions.ignoreUnreadAnys,
      catchVariables: {},
      debug: lintOptions.debug,
      strict: lintOptions.strict,
      processAny: lintOptions.processAny,
      checker,
      ingoreMap,
      ignoreNested: lintOptions.ignoreNested,
      ignoreAsAssertion: lintOptions.ignoreAsAssertion,
      ignoreTypeAssertion: lintOptions.ignoreTypeAssertion,
      ignoreNonNullAssertion: lintOptions.ignoreNonNullAssertion,
      ignoreObject: lintOptions.ignoreObject,
      ignoreEmptyType: lintOptions.ignoreEmptyType,
    }

    /* 关键流程：单个文件遍历所有的子节点 */
    sourceFile.forEachChild(node => {
      /* 检测节点，并更新context的值 */
      /* ？为什么选择引用传递？？ */
      checkNode(node, context)
    })

    /* 更新correctCount  把当前文件的数据累加上*/
    correctCount += context.typeCheckResult.correctCount
    /* 更新totalCount 把当前文件的数据累加上*/
    totalCount += context.typeCheckResult.totalCount

    /* 把当前文件的anys数据累加 */
    anys.push(...context.typeCheckResult.anys.map((a) => ({ file, ...a })))

    if (lintOptions.reportSemanticError) {
      const diagnostics = program.getSemanticDiagnostics(sourceFile)
      for (const diagnostic of diagnostics) {
        if (diagnostic.start !== undefined) {
          totalCount++
          let text: string
          if (typeof diagnostic.messageText === 'string') {
            text = diagnostic.messageText
          } else {
            text = diagnostic.messageText.messageText
          }
          const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, diagnostic.start)
          anys.push({
            line,
            character,
            text,
            kind: FileAnyInfoKind.semanticError,
            file,
          })
        }
      }
    }

    /* 如果需要统计每个文件的信息 */
    if (lintOptions.fileCounts) {
      /* 更新当前文件的统计结果 */
      fileCounts.set(file, {
        correctCount: context.typeCheckResult.correctCount,
        totalCount: context.typeCheckResult.totalCount
      })
    }

    /* 如果启用了缓存 */
    if (lintOptions.enableCache) {
      /* 把本次计算的结果保存一份到缓存对象中 */
      const resultCache = typeCheckResult.cache[file]
      /* 如果该缓存对象已经存在，那么就更新数据，否则那就新建缓存对象 */
      if (resultCache) {
        resultCache.hash = hash
        resultCache.correctCount = context.typeCheckResult.correctCount
        resultCache.totalCount = context.typeCheckResult.totalCount
        resultCache.anys = context.typeCheckResult.anys
      } else {
        typeCheckResult.cache[file] = {
          hash,
          ...context.typeCheckResult
        }
      }
    }
  }

  /* 再操作的最后，检查是否启用了缓存 */
  if (lintOptions.enableCache) {
    /* 如果启用了缓存，那就把缓存数据保存起来 */
    await saveCache(typeCheckResult, lintOptions.cacheDirectory)
  }

  // 返回计算的结果
  return { correctCount, totalCount, anys, program, fileCounts }
}

const defaultLintOptions: LintOptions = {
  debug: false,
  files: undefined,
  oldProgram: undefined,
  strict: false,
  enableCache: false,
  ignoreCatch: false,
  ignoreFiles: undefined,
  ignoreUnreadAnys: false,
  fileCounts: false,
  ignoreNested: false,
  ignoreAsAssertion: false,
  ignoreTypeAssertion: false,
  ignoreNonNullAssertion: false,
  ignoreObject: false,
  ignoreEmptyType: false,
  reportSemanticError: false,
}

/**
 * @public
 */
// export function lintSync(compilerOptions: ts.CompilerOptions, rootNames: string[], options?: Partial<LintOptions>) {
//   const lintOptions = { ...defaultLintOptions, ...options }

//   const program = ts.createProgram(rootNames, compilerOptions, undefined, lintOptions.oldProgram)
//   const checker = program.getTypeChecker()

//   const allFiles = new Set<string>()
//   const sourceFileInfos: SourceFileInfoWithoutCache[] = []
//   const ignoreFileGlobs = lintOptions.ignoreFiles
//     ? (typeof lintOptions.ignoreFiles === 'string'
//       ? [lintOptions.ignoreFiles]
//       : lintOptions.ignoreFiles)
//     : undefined
//   for (const sourceFile of program.getSourceFiles()) {
//     let file = sourceFile.fileName
//     if (!file.includes('node_modules') && (!lintOptions.files || lintOptions.files.includes(file))) {
//       if (!lintOptions.absolutePath) {
//         file = path.relative(process.cwd(), file)
//         if (file.startsWith('..')) {
//           continue
//         }
//       }
//       if (ignoreFileGlobs && ignoreFileGlobs.some((f) => minimatch(file, f))) {
//         continue
//       }
//       allFiles.add(file)
//       sourceFileInfos.push({
//         file,
//         sourceFile,
//       })
//     }
//   }

//   let correctCount = 0
//   let totalCount = 0
//   const anys: Array<AnyInfo & { sourceFile: ts.SourceFile }> = []
//   const fileCounts =
//     new Map<string, Pick<FileTypeCheckResult, 'correctCount' | 'totalCount'>>()
//   for (const { sourceFile, file } of sourceFileInfos) {
//     const ingoreMap = collectIgnoreMap(sourceFile, file)
//     const context: FileContext = {
//       file,
//       sourceFile,
//       typeCheckResult: {
//         correctCount: 0,
//         totalCount: 0,
//         anys: []
//       },
//       ignoreCatch: lintOptions.ignoreCatch,
//       ignoreUnreadAnys: lintOptions.ignoreUnreadAnys,
//       catchVariables: {},
//       debug: lintOptions.debug,
//       strict: lintOptions.strict,
//       processAny: lintOptions.processAny,
//       checker,
//       ingoreMap,
//       ignoreNested: lintOptions.ignoreNested,
//       ignoreAsAssertion: lintOptions.ignoreAsAssertion,
//       ignoreTypeAssertion: lintOptions.ignoreTypeAssertion,
//       ignoreNonNullAssertion: lintOptions.ignoreNonNullAssertion,
//       ignoreObject: lintOptions.ignoreObject,
//       ignoreEmptyType: lintOptions.ignoreEmptyType,
//     }

//     sourceFile.forEachChild(node => {
//       checkNode(node, context)
//     })

//     correctCount += context.typeCheckResult.correctCount
//     totalCount += context.typeCheckResult.totalCount
//     anys.push(...context.typeCheckResult.anys.map((a) => ({ file, ...a, sourceFile })))

//     if (lintOptions.fileCounts) {
//       fileCounts.set(file, {
//         correctCount: context.typeCheckResult.correctCount,
//         totalCount: context.typeCheckResult.totalCount
//       })
//     }
//   }

//   return { correctCount, totalCount, anys, program, fileCounts }
// }
