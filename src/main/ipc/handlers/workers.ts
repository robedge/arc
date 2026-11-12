import type { AppServices } from '../../app/app-services'
import { handle } from '../register'

export function registerWorkerHandlers(services: Pick<AppServices, 'sessions'>): void {
  const { sessions } = services
  handle('workers:get', ({ workerId }) => sessions.workerDetails(workerId))
  handle('workers:open-terminal', ({ workerId }) => sessions.openTerminal(workerId))
  handle('workers:stop', ({ workerId }) => sessions.stopWorker(workerId))
  handle('workers:remove', ({ workerId }) => sessions.removeWorker(workerId))
  handle('workers:step-in', ({ workerId }) => sessions.stepInWorker(workerId))
  handle('workers:hand-back', ({ workerId }) => sessions.handBackWorker(workerId))
  handle('workers:send-input', ({ workerId, text }) => sessions.sendWorkerInput(workerId, text))
  handle('workers:interrupt', ({ workerId }) => sessions.interruptWorker(workerId))
  handle('workers:continue', (request) =>
    'all' in request
      ? sessions.continueAllWorkers(request.sessionId)
      : sessions.continueWorker(request.workerId)
  )
}
