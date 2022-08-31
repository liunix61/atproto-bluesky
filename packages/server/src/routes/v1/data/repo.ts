import express from 'express'
import * as util from '../../../util'
import { getRepoRequest, postRepoRequest } from '@adxp/api'
import { AdxUri, DataDiff, Repo, service } from '@adxp/common'
import Database from '../../../db/index'
import { ServerError } from '../../../error'
import * as subscriptions from '../../../subscriptions'

const router = express.Router()

router.get('/', async (req, res) => {
  const query = util.checkReqBody(req.query, getRepoRequest)
  const { did, from = null } = query
  const repo = await util.loadRepo(res, did)
  const diff = await repo.getDiffCar(from)
  res.status(200).send(Buffer.from(diff))
})

router.post('/:did', async (req, res) => {
  // we don't need auth here because the auth is on the data structure 😎
  const { did } = util.checkReqBody(req.params, postRepoRequest)
  const bytes = await util.readReqBytes(req)

  const db = util.getDB(res)

  // @TODO Add fix something here
  // check to see if we have their username in DB, for indexed queries
  // const haveUsername = await db.isDidRegistered(did)
  // if (!haveUsername) {
  //   const username = await service.getUsernameFromDidNetwork(did)
  //   if (username) {
  //     const [name, host] = username.split('@')
  //     await db.registerDid(name, did, host)
  //   }
  // }

  const maybeRepo = await util.maybeLoadRepo(res, did)
  const isNewRepo = maybeRepo === null
  let repo: Repo
  let diff: DataDiff

  // @TODO: we should do these on a temp in-memory blockstore before merging down to our on-disk one
  if (!isNewRepo) {
    repo = maybeRepo
    await repo.loadAndVerifyDiff
    diff = await repo.loadAndVerifyDiff(bytes)
  } else {
    const blockstore = util.getBlockstore(res)
    repo = await Repo.fromCarFile(bytes, blockstore)
    diff = await repo.verifySetOfUpdates(null, repo.cid)
  }

  await processDiff(db, util.getOwnHost(req), repo, did, diff)

  await subscriptions.notifySubscribers(db, repo)

  await db.setRepoRoot(did, repo.cid)

  res.status(200).send()
})

const processDiff = async (
  db: Database,
  ownHost: string,
  repo: Repo,
  did: string,
  diff: DataDiff,
): Promise<void> => {
  const adds = diff.addList().map(async (add) => {
    const loaded = await repo.blockstore.getUnchecked(add.cid)
    const uri = new AdxUri(`${did}/${add.key}`)
    await db.indexRecord(uri, loaded)
  })
  const updates = diff.updateList().map(async (update) => {
    const loaded = await repo.blockstore.getUnchecked(update.cid)
    const uri = new AdxUri(`${did}/${update.key}`)
    await db.indexRecord(uri, loaded)
  })
  const deletes = diff.deleteList().map(async (del) => {
    const uri = new AdxUri(`${did}/${del.key}`)
    await db.deleteRecord(uri)
  })

  await Promise.all([...adds, ...updates, ...deletes])

  // @TODO notify subscribers
}

export default router
