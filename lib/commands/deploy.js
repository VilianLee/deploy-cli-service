const fs = require('fs')
const ora = require('ora')
const inquirer = require('inquirer')
const { NodeSSH } = require('node-ssh')
const childProcess = require('child_process')
const { deployConfigPath } = require('../config')
const {
  checkDeployConfigExists,
  log,
  succeed,
  error,
  underline
} = require('../utils')

const ssh = new NodeSSH()
const maxBuffer = 5000 * 1024

// 任务列表
let taskList

// 是否确认部署
const confirmDeploy = (message) => {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message
    }
  ])
}

// 检查环境是否正确
const checkEnvCorrect = (config, env) => {
  const keys = [
    'name',
    'script',
    'host',
    'port',
    'username',
    'distPath',
    'webDir'
  ]

  if (
    config &&
    (function () {
      const { privateKey, password } = config
      if (!privateKey && !password) {
        error(
          `配置错误: 请配置 ${underline('privateKey')} 或 ${underline(
            'passwrod'
          )}`
        )
        process.exit(1)
      }
      return true
    })()
  ) {
    keys.forEach((key) => {
      if (!config[key] || config[key] === '/') {
        error(
          `配置错误: ${underline(`${env}环境`)} ${underline(
            `${key}属性`
          )} 配置不正确`
        )
        process.exit(1)
      }
    })
  } else {
    error('配置错误: 未指定部署环境或指定部署环境不存在')
    process.exit(1)
  }
}

// 执行打包脚本
const execBuild = async (config, index) => {
  try {
    const { script } = config
    log(`(${index}) ${script}`)
    const spinner = ora('正在打包中\n')

    spinner.start()

    await new Promise((resolve, reject) => {
      childProcess.exec(
        script,
        { cwd: process.cwd(), maxBuffer: maxBuffer },
        (e) => {
          spinner.stop()
          if (e === null) {
            succeed('打包成功')
            resolve()
          } else {
            reject(e.message)
          }
        }
      )
    })
  } catch (e) {
    error('打包失败')
    error(e)
    process.exit(1)
  }
}

// 连接ssh
const connectSSH = async (config, index) => {
  try {
    log(`(${index}) ssh连接 ${underline(config.host)}`)
    await ssh.connect(config)
    succeed('ssh连接成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 上传本地文件
const uploadLocalFile = async (config, index) => {
  try {
    const backPath = `${config.webDir}.back`
    const localPath = `${process.cwd()}/${config.distPath}`

    log(`(${index}) 上传打包文件至目录 ${underline(config.webDir)}`)

    const spinner = ora('正在上传中\n')

    spinner.start()

    await ssh.putDirectory(localPath, backPath, {
      recursive: true,
      concurrency: 10
    })

    spinner.stop()
    succeed('上传成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 删除远程文件
const removeRemoteFile = async (config, index) => {
  try {
    const { webDir } = config

    log(`(${index}) 删除远程文件 ${underline(webDir)}`)

    await ssh.execCommand(`rm -rf ${webDir}`)
    succeed('删除成功')
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 移动远程文件
const moveRemoteFile = async (config) => {
  try {
    const { webDir } = config

    await ssh.execCommand(`mv ${webDir}.back ${webDir}`)
  } catch (e) {
    error(e)
    process.exit(1)
  }
}

// 删除本地打包文件
const removeLocalFile = (config, index) => {
  const localPath = `${process.cwd()}/${config.distPath}`

  log(`(${index}) 删除本地打包目录 ${underline(localPath)}`)

  const remove = (path) => {
    if (fs.existsSync(path)) {
      fs.readdirSync(path).forEach((file) => {
        let currentPath = `${path}/${file}`
        if (fs.statSync(currentPath).isDirectory()) {
          remove(currentPath)
        } else {
          fs.unlinkSync(currentPath)
        }
      })
      fs.rmdirSync(path)
    }
  }

  remove(localPath)
  succeed('删除本地打包目录成功')
}

// 断开ssh
const disconnectSSH = () => {
  ssh.dispose()
}

// 创建任务列表
const createTaskList = (config) => {
  const { isRemoveRemoteFile = true } = config

  taskList = []
  taskList.push(execBuild)
  taskList.push(connectSSH)
  taskList.push(uploadLocalFile)
  isRemoveRemoteFile && taskList.push(removeRemoteFile)
  taskList.push(removeLocalFile)
  taskList.push(moveRemoteFile)
  taskList.push(disconnectSSH)
}

// 执行任务列表
const executeTaskList = async (config) => {
  for (const [index, execute] of new Map(
    taskList.map((execute, index) => [index, execute])
  )) {
    await execute(config, index + 1)
  }
}

module.exports = {
  description: '部署项目',
  apply: async (env) => {
    if (checkDeployConfigExists()) {
      const config = require(deployConfigPath)
      const projectName = config.projectName
      const envConfig = Object.assign(config[env], {
        privateKey: config.privateKey,
        passphrase: config.passphrase
      })

      checkEnvCorrect(envConfig, env)

      const answers = await confirmDeploy(
        `${underline(projectName)} 项目是否部署到 ${underline(envConfig.name)}?`
      )

      if (answers.confirm) {
        createTaskList(envConfig)

        await executeTaskList(envConfig)

        succeed(
          `恭喜您，${underline(projectName)}项目已在${underline(
            envConfig.name
          )}部署成功\n`
        )
        process.exit(0)
      } else {
        process.exit(1)
      }
    } else {
      error(
        'deploy.config.js 文件不存，请使用 deploy-cli-service init 命令创建'
      )
      process.exit(1)
    }
  }
}
