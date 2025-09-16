import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  WAMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  WAMessageKey,
  jidNormalizedUser,
  CacheStore,
  fetchLatestWaWebVersion,
  GroupMetadata
} from "baileys";
import { Op } from "sequelize";
import { FindOptions } from "sequelize/types";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import MAIN_LOGGER from "baileys/lib/Utils/logger";
import authState from "../helpers/authState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import NodeCache from 'node-cache';
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";
import { LIDMappingStore } from "baileys/lib/Signal/lid-mapping";
const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

const msgRetryCounterCache = new NodeCache({
  stdTTL: 600,
  maxKeys: 1000,
  checkperiod: 300,
  useClones: false
});

const msgCache = new NodeCache({
  stdTTL: 60,
  maxKeys: 1000,
  checkperiod: 300,
  useClones: false
});

type Session = WASocket & {
  id?: number;
  store?: Store;
};

export default function msg() {
  return {
    get: (key: WAMessageKey) => {
      const { id } = key;
      if (!id) return;
      let data = msgCache.get(id);
      if (data) {
        try {
          let msg = JSON.parse(data as string);
          return msg?.message;
        } catch (error) {
          logger.error(error);
        }
      }
    },
    save: (msg: WAMessage) => {
      const { id } = msg.key;
      const msgtxt = JSON.stringify(msg);
      try {
        msgCache.set(id as string, msgtxt);
      } catch (error) {
        logger.error(error);
      }
    }
  }
}

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

// Contador de tentativas de reconexão para erro 403
const reconnectAttempts = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const restartWbot = async (
  companyId: number,
  session?: any
): Promise<void> => {
  try {
    const options: FindOptions = {
      where: {
        companyId,
      },
      attributes: ["id"],
    }

    const whatsapp = await Whatsapp.findAll(options);

    whatsapp.map(async c => {
      const sessionIndex = sessions.findIndex(s => s.id === c.id);
      if (sessionIndex !== -1) {
        sessions[sessionIndex].ws.close();
      }

    });

  } catch (err) {
    logger.error(err);
  }
};

export const msgDB = msg();

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise(async (resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        const { version, isLatest } = await fetchLatestWaWebVersion({});
        // const { version, isLatest } = await fetchLatestBaileysVersion();
        const isLegacy = provider === "stable" ? true : false;

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`isLegacy: ${isLegacy}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session & {
          lidMappingStore?: LIDMappingStore;
        } = null;
        
        // Removido makeInMemoryStore que não existe mais na versão 6.7.16
        // Usando apenas caches externos conforme exemplo oficial

        const { state, saveState } = await authState(whatsapp);

        const userDevicesCache: CacheStore = new NodeCache();
        const signalKeyStore = makeCacheableSignalKeyStore(state.keys, logger, userDevicesCache);

        const groupCache = new NodeCache({
          stdTTL: 3600,
          maxKeys: 10000,
          checkperiod: 600,
          useClones: false
        })

         const lidMappingStore = new LIDMappingStore(
          signalKeyStore as any, // Cast temporário para compatibilidade
          async (...jids: string[]) => {
            // Função para verificar JIDs no WhatsApp e obter LIDs
            try {
              const results = await wsocket?.onWhatsApp(...jids);
              return results?.map(result => ({
                jid: result.jid,
                exists: result.exists,
                lid: result.lid || result.jid
              }));
            } catch (error) {
              logger.error("Erro ao verificar JIDs no WhatsApp:", error);
              return undefined;
            }
          }
        );

        const cachedGroupMetadata = async (jid: string):  Promise<GroupMetadata> => {
            let data:GroupMetadata = groupCache.get(jid);
            console.log('cachedGroupMetadata jid:', jid, 'data:', !!data);
            if (data) {
              return data;
            } else {
              const result = await wsocket.groupMetadata(jid);
              groupCache.set(jid, result);
              return result;
            }
        };

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          auth: {
            creds: state.creds,
            keys: signalKeyStore,
          },
          version,
          browser: Browsers.appropriate("Desktop"),
          defaultQueryTimeoutMs: undefined,
          msgRetryCounterCache,
          markOnlineOnConnect: false,
          connectTimeoutMs: 25_000,
          retryRequestDelayMs: 500,
          getMessage: msgDB.get,
          emitOwnEvents: true,
          fireInitQueries: true,
          transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
          shouldIgnoreJid: jid => isJidBroadcast(jid),
          cachedGroupMetadata,
        });


        

        // PATCH ESPECÍFICO - Converter objetos Object() para Buffer
        const originalBufferFrom = Buffer.from;
        Buffer.from = function(value: any, ...args: any[]) {
          try {
            // Interceptar APENAS objetos Object() que não são válidos para Buffer.from
            if (typeof value === 'object' && value !== null && 
                !Array.isArray(value) && 
                !Buffer.isBuffer(value) && 
                !(value instanceof Uint8Array) &&  // NÃO interceptar Uint8Array
                !(value instanceof ArrayBuffer) &&  // NÃO interceptar ArrayBuffer
                value.constructor === Object) {     // APENAS objetos Object()
              
              // console.log(`🚨 INTERCEPTADO Buffer.from com objeto Object() inválido:`, {
              //   type: typeof value,
              //   constructor: value.constructor?.name,
              //   keys: Object.keys(value),
              //   value: value
              // });
              
              // Tentar converter o objeto Object() para array e depois para Buffer
              try {
                const keys = Object.keys(value);
                const isNumericKeys = keys.every(key => /^\d+$/.test(key));
                
                if (isNumericKeys) {
                  // Converter objeto com chaves numéricas para array
                  const maxIndex = Math.max(...keys.map(k => parseInt(k)));
                  const array = new Array(maxIndex + 1);
                  
                  for (let i = 0; i <= maxIndex; i++) {
                    array[i] = value[i] || 0;
                  }
                  
                  const buffer = Buffer.from(array);
                  console.log(`✅ Convertido objeto Object() para Buffer (${buffer.length} bytes)`);
                  return buffer;
                } else {
                  console.log(`⚠️ Objeto Object() não tem chaves numéricas, retornando Buffer vazio`);
                  return Buffer.from([]);
                }
              } catch (conversionError) {
                console.error(`❌ Erro ao converter objeto Object() para Buffer:`, conversionError);
                return Buffer.from([]);
              }
            }
            
            return originalBufferFrom.call(this, value, ...args);
          } catch (error) {
            console.error(`❌ Erro no Buffer.from interceptado:`, error);
            // Retornar Buffer vazio como fallback
            return Buffer.from([]);
          }
        };

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(`Socket ${name} Connection Update: ${connection}`);
            
            // Log detalhado de desconexões
            if (lastDisconnect) {
              const error = lastDisconnect.error as Boom;
              logger.warn(`Desconexão detectada para ${name}:`, {
                statusCode: error?.output?.statusCode,
                message: error?.message,
                timestamp: new Date().toISOString()
              });
            }


          
            const disconect = (lastDisconnect?.error as Boom)?.output?.statusCode;

            if (connection === "close") {
              if (disconect === 403) {
                logger.warn(`Erro 403 detectado para ${name}. Tentando reconexão inteligente...`);
                
                // NÃO deletar dados imediatamente - tentar reconectar primeiro
                const attempts = reconnectAttempts.get(id) || 0;
                
                if (attempts < 5) { // Máximo 5 tentativas
                  logger.info(`Tentativa ${attempts + 1} de reconexão para ${name}`);
                  reconnectAttempts.set(id, attempts + 1);
                  
                  // Tentar reconectar sem deletar dados
                  setTimeout(() => {
                    StartWhatsAppSession(whatsapp, whatsapp.companyId);
                  }, [2000, 5000, 10000, 30000, 60000][attempts]); // Delays progressivos
                  
                  return; // NÃO deletar dados ainda
                } else {
                  // Após 5 tentativas, então deletar dados
                  logger.error(`Máximo de tentativas atingido para ${name}. Deletando sessão.`);
                  await whatsapp.update({ status: "PENDING", session: "", number: "" });
                  removeWbot(id, false);
                  await DeleteBaileysService(whatsapp.id);
                  reconnectAttempts.delete(id);
                  
                  io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                    action: "update",
                    session: whatsapp
                  });
                }
              }

              if (disconect !== DisconnectReason.loggedOut) {
                removeWbot(id, false);
                setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
              } else {
                await whatsapp.update({ status: "PENDING", session: "", number: "" });
                await DeleteBaileysService(whatsapp.id);

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
                setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
              }
            }

            if (connection === "open") {
              // Limpar tentativas de reconexão quando conectar com sucesso
              reconnectAttempts.delete(id);
              
              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0,
                number:
                  wsocket.type === "md"
                    ? jidNormalizedUser((wsocket as WASocket).user.id).split("@")[0]
                    : "-"
              });

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsapp.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsapp.id);

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0,
                  number: ""
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
              }
            }
          }
        );
        wsocket.ev.on("creds.update", saveState);

        wsocket.ev.on(
          "presence.update",
          async ({ id: remoteJid, presences }) => {
            try {
              logger.debug(
                { remoteJid, presences },
                "Received contact presence"
              );
              if (!presences[remoteJid]?.lastKnownPresence) {
                return;
              }
              const contact = await Contact.findOne({
                where: {
                  number: remoteJid.replace(/\D/g, ""),
                  companyId: whatsapp.companyId
                }
              });
              if (!contact) {
                return;
              }
              const ticket = await Ticket.findOne({
                where: {
                  contactId: contact.id,
                  whatsappId: whatsapp.id,
                  status: {
                    [Op.or]: ["open", "pending"]
                  }
                }
              });

              if (ticket) {
                io.to(ticket.id.toString())
                  .to(`company-${whatsapp.companyId}-${ticket.status}`)
                  .to(`queue-${ticket.queueId}-${ticket.status}`)
                  .emit(`company-${whatsapp.companyId}-presence`, {
                    ticketId: ticket.id,
                    presence: presences[remoteJid].lastKnownPresence
                  });
              }
            } catch (error) {
              logger.error(
                { remoteJid, presences },
                "presence.update: error processing"
              );
              if (error instanceof Error) {
                logger.error(`Error: ${error.name} ${error.message}`);
              } else {
                logger.error(`Error was object of type: ${typeof error}`);
              }
            }
          }
        );

         wsocket.lidMappingStore = lidMappingStore;

        // Removida a linha que vinculava o store ao socket
        // store.bind(wsocket.ev);
      })();
    } catch (error) {
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};
