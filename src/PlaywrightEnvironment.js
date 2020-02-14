import NodeEnvironment from 'jest-environment-node'
import {
  checkBrowserEnv,
  checkDeviceEnv,
  getBrowserType,
  getDeviceType,
  getPlaywrightInstance,
  readConfig,
} from './utils'

const handleError = error => {
  process.emit('uncaughtException', error)
}

const KEYS = {
  CONTROL_C: '\u0003',
  CONTROL_D: '\u0004',
  ENTER: '\r',
}

let browserPerProcess = null
let browserShutdownTimeout = 0

function resetBrowserCloseWatchdog() {
  if (browserShutdownTimeout) clearTimeout(browserShutdownTimeout)
}

// Since there are no per-worker hooks, we have to setup a timer to
// close the browser.
//
// @see https://github.com/facebook/jest/issues/8708 (and upvote plz!)
function startBrowserCloseWatchdog() {
  resetBrowserCloseWatchdog()
  browserShutdownTimeout = setTimeout(async () => {
    const browser = browserPerProcess
    browserPerProcess = null
    if (browser) await browser.close()
  }, 50)
}

async function getBrowserPerProcess(playwrightInstance, config) {
  if (!browserPerProcess) {
    const browserType = getBrowserType(config)
    checkBrowserEnv(browserType)
    const { launchBrowserApp } = config
    browserPerProcess = await playwrightInstance.launch(launchBrowserApp)
  }
  return browserPerProcess
}

class PlaywrightEnvironment extends NodeEnvironment {
  // Jest is not available here, so we have to reverse engineer
  // the setTimeout function, see https://github.com/facebook/jest/blob/v23.1.0/packages/jest-runtime/src/index.js#L823
  setTimeout(timeout) {
    if (this.global.jasmine) {
      // eslint-disable-next-line no-underscore-dangle
      this.global.jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout
    } else {
      this.global[Symbol.for('TEST_TIMEOUT_SYMBOL')] = timeout
    }
  }

  async setup() {
    resetBrowserCloseWatchdog()
    const config = await readConfig()
    const browserType = getBrowserType(config)
    checkBrowserEnv(browserType)
    const { context } = config
    const device = getDeviceType(config)
    const playwrightInstance = await getPlaywrightInstance(browserType)
    let contextOptions = context

    const availableDevices = Object.keys(playwrightInstance.devices)
    if (device) {
      if (typeof device === 'object') {
        const { viewport, userAgent } = device
        contextOptions = { ...contextOptions, viewport, userAgent }
      } else {
        checkDeviceEnv(device, availableDevices)
        const { viewport, userAgent } = playwrightInstance.devices[device]
        contextOptions = { ...contextOptions, viewport, userAgent }
      }
    }
    this.global.browser = await getBrowserPerProcess(playwrightInstance, config)
    this.global.context = await this.global.browser.newContext(contextOptions)
    this.global.page = await this.global.context.newPage()
    this.global.page.on('pageerror', handleError)
    this.global.jestPlaywright = {
      debug: async () => {
        // eslint-disable-next-line no-eval
        // Set timeout to 4 days
        this.setTimeout(345600000)
        // Run a debugger (in case Playwright has been launched with `{ devtools: true }`)
        await this.global.page.evaluate(() => {
          // eslint-disable-next-line no-debugger
          debugger
        })
        // eslint-disable-next-line no-console
        console.log('\n\n🕵️‍  Code is paused, press enter to resume')
        // Run an infinite promise
        return new Promise(resolve => {
          const { stdin } = process
          const listening = stdin.listenerCount('data') > 0
          const onKeyPress = key => {
            if (
              key === KEYS.CONTROL_C ||
              key === KEYS.CONTROL_D ||
              key === KEYS.ENTER
            ) {
              stdin.removeListener('data', onKeyPress)
              if (!listening) {
                if (stdin.isTTY) {
                  stdin.setRawMode(false)
                }
                stdin.pause()
              }
              resolve()
            }
          }
          if (!listening) {
            if (stdin.isTTY) {
              stdin.setRawMode(true)
            }
            stdin.resume()
            stdin.setEncoding('utf8')
          }
          stdin.on('data', onKeyPress)
        })
      },
    }
  }

  async teardown() {
    await super.teardown()
    if (this.global.page) {
      this.global.page.removeListener('pageerror', handleError)
      await this.global.page.close()
    }
    startBrowserCloseWatchdog()
  }
}

export default PlaywrightEnvironment
