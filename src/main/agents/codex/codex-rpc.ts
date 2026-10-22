import { JsonRpcPeer, DEFAULT_RPC_TIMEOUT_MS, type RpcTransport } from '../rpc/json-rpc-peer'

/**
 * JSON-RPC over the app-server's stdio. The transport is `JsonRpcPeer`; this wrapper names the
 * peer for its errors. The app-server leaves out the `jsonrpc` field, so none is sent.
 */

export {
  DEFAULT_RPC_TIMEOUT_MS,
  RpcClosedError,
  RpcError,
  RpcTimeoutError,
  type RpcServerRequest,
  type RpcTransport
} from '../rpc/json-rpc-peer'

export class CodexRpc extends JsonRpcPeer {
  constructor(transport: RpcTransport, defaultTimeoutMs: number = DEFAULT_RPC_TIMEOUT_MS) {
    super(transport, defaultTimeoutMs, { peerName: 'The Codex app-server' })
  }
}
