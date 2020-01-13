/* eslint-disable no-console */

import Bluebird from 'bluebird'
import Debug from 'debug'
import _ from 'lodash'
import Marionette from 'marionette-client'
import Exception from 'marionette-client/lib/marionette/error'
import Foxdriver from '@benmalka/foxdriver'
import { Command } from 'marionette-client/lib/marionette/message.js'
import util from 'util'
import protocol from './protocol'

const debug = Debug('cypress:server:browsers')

const promisify = (fn) => {
  return (...args) => {
    return new Bluebird((resolve, reject) => {
      fn(...args, (data) => {
        if ('error' in data) {
          reject(new Exception(data, data))
        } else {
          resolve(data)
        }
      })
    })
  }
}

let sendMarionette

let cb

let timings = {
  gc: [] as any[],
  cc: [] as any[],
}

export const log = () => {
  console.log('timings', util.inspect(timings, {
    breakLength: Infinity,
    maxArrayLength: Infinity,
  }))

  console.log('times', {
    gc: timings.gc.length,
    cc: timings.cc.length,
  })

  console.log('average', {
    gc: _.chain(timings.gc).sum().divide(timings.gc.length).value(),
    cc: _.chain(timings.cc).sum().divide(timings.cc.length).value(),
  })

  console.log('total', {
    gc: _.sum(timings.gc),
    cc: _.sum(timings.cc),
  })

  // reset all the timings
  timings = {
    gc: [],
    cc: [],
  }
}

export function collectGarbage () {
  return cb()
}

export function setup (extensions, url) {
  return Bluebird.all([
    setupFoxdriver(),
    setupMarionette(extensions, url),
  ])
}

export async function setupFoxdriver () {
  await protocol._connectAsync({
    host: '127.0.0.1',
    port: 2929,
  })

  const { browser } = await Foxdriver.attach('127.0.0.1', 2929)

  const attach = async (tab) => {
    return await tab.memory.attach()
  }

  cb = () => {
    let duration

    const gc = (tab) => {
      return () => {
        if (process.env.CYPRESS_SKIP_GC) {
          return
        }

        console.time('garbage collection')
        duration = Date.now()

        return tab.memory.forceGarbageCollection()
        .then(() => {
          console.timeEnd('garbage collection')

          timings.gc.push(Date.now() - duration)
        })
      }
    }

    const cc = (tab) => {
      return () => {
        if (process.env.CYPRESS_SKIP_CC) {
          return
        }

        console.time('cycle collection')
        duration = Date.now()

        return tab.memory.forceCycleCollection()
        .then(() => {
          console.timeEnd('cycle collection')

          timings.cc.push(Date.now() - duration)
        })
      }
    }

    return browser.listTabs()
    .then((tabs) => {
      browser.tabs = tabs

      return Bluebird.mapSeries(tabs, (tab: any) => {
        // FIXME: do we really need to attach and detach every time?
        return attach(tab)
        .then(gc(tab))
        .then(cc(tab))
        // .then(() => {
        // return tab.memory.measure()
        // .then(console.log)
        // })
        .then(() => {
          return tab.memory.detach()
        })
      })
    })
  }
}

export async function setupMarionette (extensions, url) {
  const driver = new Marionette.Drivers.Tcp({})

  const connect = Bluebird.promisify(driver.connect.bind(driver))
  const driverSend = promisify(driver.send.bind(driver))

  sendMarionette = (data) => {
    return driverSend(new Command(data))
  }

  debug('firefox: navigating page with webdriver')

  await connect()

  const { sessionId } = await sendMarionette({
    name: 'WebDriver:NewSession',
    parameters: { acceptInsecureCerts: true },
  })

  await Bluebird.all(_.map(extensions, (path) => {
    return sendMarionette({
      name: 'Addon:Install',
      sessionId,
      parameters: { path, temporary: true },
    })
  }))

  await sendMarionette({
    name: 'WebDriver:Navigate',
    sessionId,
    parameters: { url },
  })
}
