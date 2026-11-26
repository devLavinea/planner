
import { initializeApp, getApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";

// Lê as variáveis do arquivo .env.local
const env = import.meta.env;

// Remove espaços e trata valores vazios
const getEnv = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim();
  return cleaned || undefined;
};

// Configuração do Firebase
const firebaseConfig = {
  apiKey: getEnv(env.VITE_FIREBASE_API_KEY),
  authDomain: getEnv(env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: getEnv(env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: getEnv(env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: getEnv(env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: getEnv(env.VITE_FIREBASE_APP_ID),
  measurementId: getEnv(env.VITE_FIREBASE_MEASUREMENT_ID),
};

// Verifica as configurações obrigatórias
const requiredConfig: Array<[string, string | undefined]> = [
  ["VITE_FIREBASE_API_KEY", firebaseConfig.apiKey],
  ["VITE_FIREBASE_AUTH_DOMAIN", firebaseConfig.authDomain],
  ["VITE_FIREBASE_PROJECT_ID", firebaseConfig.projectId],
  ["VITE_FIREBASE_MESSAGING_SENDER_ID", firebaseConfig.messagingSenderId],
  ["VITE_FIREBASE_APP_ID", firebaseConfig.appId],
];

const missingConfig = requiredConfig
  .filter(([, value]) => !value)
  .map(([name]) => name);

// Mostra um erro detalhado caso faltem variáveis
if (missingConfig.length > 0) {
  const detectedVariables = Object.keys(env).filter((key) =>
    key.startsWith("VITE_FIREBASE_")
  );

  throw new Error(
    [
      "Não foi possível carregar a configuração do Firebase.",
      `Variáveis ausentes: ${missingConfig.join(", ")}`,
      `Variáveis detectadas pelo Vite: ${
        detectedVariables.length
          ? detectedVariables.join(", ")
          : "Nenhuma"
      }`,
      "Verifique se o arquivo .env.local está na raiz do projeto,",
      "na mesma pasta do package.json.",
      "Depois, pare e reinicie o servidor com npm run dev.",
    ].join("\n")
  );
}

// Inicializa o Firebase sem duplicar o aplicativo
const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

// Firestore
export const db = getFirestore(app);

// Authentication
export const auth = getAuth(app);

// Login com Google
export const googleProvider = new GoogleAuthProvider();

// Mantém a sessão do usuário no navegador
export async function prepareLocalAuthPersistence(): Promise<void> {
  await setPersistence(auth, browserLocalPersistence);
}
