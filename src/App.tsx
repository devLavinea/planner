import plannerLogo from './assets/planner-logo.png';
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail, signOut, type User } from 'firebase/auth';
import { auth, db, googleProvider, prepareLocalAuthPersistence } from './firebase';
import type { FormEvent } from 'react';
import './App.css';

type Priority = 'Baixa' | 'Média' | 'Alta';
type PlannerType = 'Pessoal' | 'Profissional';
type Task = { id: string; title: string; date: string; time: string; category: string; subcategory?: string; professor?: string; priority: Priority; done: boolean; note: string; planner: PlannerType; accountId: string; userId: string; seriesId?: string };
type ImportantDate = { id: string; title: string; date: string; note: string; category: string; planner: PlannerType; accountId: string; userId: string; seriesId?: string; recurringForever?: boolean; repeatType?: 'weekly' | 'monthly' | 'yearly'; repeatDays?: number[] };
type Account = { id: string; name: string; email: string; color: string; ownerUid?: string };
type TaskCategory = { name: string; subcategories: string[] };
const defaultProfessionalCategories: TaskCategory[] = [
  { name: 'Solicitação da gestão', subcategories: [] },
  { name: 'Solicitação da coordenação', subcategories: [] },
  { name: 'Solicitação da secretaria', subcategories: [] },
  { name: 'Solicitação de professor', subcategories: ['Iany', 'Renata'] },
];

const today = new Date();
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const initialAccounts: Account[] = [
  { id: 'lavinea', name: 'Lavinea', email: 'Minha conta', color: '#647cce' },
  { id: 'gabriel', name: 'Gabriel', email: 'Outra conta', color: '#269b78' },
];
function parseVoiceTask(text: string, planner: PlannerType) {
  const normalized = text.toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  const monthPattern = 'janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
  const dayMatch = normalized.match(new RegExp(`(?:dia\\s*)?(\\d{1,2})(?:\\s+de\\s+(${monthPattern}))?`));
  const timeMatch = normalized.match(/(?:às|as)\s*(\d{1,2})(?::(\d{2})|\s*(?:h|horas?)(?:\s*(\d{1,2})\s*(?:min(?:utos?)?)?)?)?/);
  let date = dateKey(new Date());
  if (dayMatch) {
    const monthNames: Record<string, number> = { janeiro: 0, fevereiro: 1, março: 2, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };
    const day = Number(dayMatch[1]);
    const month = dayMatch[2] ? monthNames[dayMatch[2]] : new Date().getMonth();
    const year = new Date().getFullYear();
    let candidate = new Date(year, month, day, 12);
    if (!dayMatch[2] && candidate < new Date(new Date().setHours(0, 0, 0, 0))) candidate = new Date(year, month + 1, day, 12);
    if (candidate.getDate() === day) date = dateKey(candidate);
  }
  const minutes = timeMatch ? (timeMatch[2] || timeMatch[3] || '00') : '00';
  const time = timeMatch ? `${String(Number(timeMatch[1])).padStart(2, '0')}:${String(Number(minutes)).padStart(2, '0')}` : '';
  let title = normalized
    .replace(new RegExp(`(?:no\\s+)?dia\\s*\\d{1,2}(?:\\s+de\\s+(?:${monthPattern}))?|\\b\\d{1,2}\\s+de\\s+(?:${monthPattern})\\b`, 'g'), ' ')
    .replace(/(?:às|as)\s*\d{1,2}(?::\d{2}|\s*(?:h|horas?)(?:\s*\d{1,2}\s*(?:min(?:utos?)?)?)?)?/g, ' ')
    .replace(/\b(preciso|precisarei|tenho|que|fazer|realizar|agendar|marcar|uma|um|tarefa|no|para)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  title = title.replace(/^(de|para|sobre)\s+/, '').replace(/^[:,-]+|[:,-]+$/g, '').trim();
  if (!title) title = text.trim();
  return { title: title.charAt(0).toUpperCase() + title.slice(1), date, time, planner };
}
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

export default function App() {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [account, setAccount] = useState(initialAccounts[0]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [importantDates, setImportantDates] = useState<ImportantDate[]>([]);
  const [section, setSection] = useState<'Visão geral' | 'Anotações' | 'Configurações'>('Visão geral');
  const [professionalCategories, setProfessionalCategories] = useState<TaskCategory[]>(defaultProfessionalCategories);
  const [personalCategories, setPersonalCategories] = useState<TaskCategory[]>(['Pessoal','Trabalho','Estudos','Saúde','Financeiro','Outro'].map(name => ({ name, subcategories: [] })));
  const [professionalDateCategories, setProfessionalDateCategories] = useState<string[]>(['Reuniões', 'Eventos escolares', 'Prazos', 'Formações', 'Feriados', 'Outros']);
  const [personalDateCategories, setPersonalDateCategories] = useState<string[]>(['Aniversários', 'Família', 'Saúde', 'Comemorações', 'Compromissos', 'Outros']);
  const [configCategoryType, setConfigCategoryType] = useState<'Tarefas' | 'Datas importantes'>('Tarefas');
  const [configCategory, setConfigCategory] = useState('Solicitação de professor');
  const [categoryDialog, setCategoryDialog] = useState<'category' | 'subcategory' | null>(null);
  const [categoryNameDraft, setCategoryNameDraft] = useState('');
  const [taskCategorySelection, setTaskCategorySelection] = useState('Solicitação da gestão');
  const [modal, setModal] = useState<'task' | 'date' | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<'Mês' | 'Semana' | 'Dia'>('Mês');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'Tudo' | 'Tarefas' | 'Datas importantes'>('Tudo');
  const [recurring, setRecurring] = useState(false);
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatType, setRepeatType] = useState<'weekly' | 'monthly' | 'yearly'>('weekly');
  const [selectedDate, setSelectedDate] = useState(dateKey(today));
  const [calendarMonth, setCalendarMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [taskStartDate, setTaskStartDate] = useState(dateKey(today));
  const [repeatUntil, setRepeatUntil] = useState(dateKey(today));
  const [repeatForever, setRepeatForever] = useState(false);
  const [activePlanner, setActivePlanner] = useState<PlannerType>('Profissional');
  const [voiceDraft, setVoiceDraft] = useState<{ title: string; date: string; time: string; planner: PlannerType } | null>(null);
  const [listening, setListening] = useState(false);
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [firebaseError, setFirebaseError] = useState('');
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerMode, setRegisterMode] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');

  useEffect(() => onAuthStateChanged(auth, async user => {
    setAuthLoading(true);
    if (!user) {
      setAuthUser(null);
      setFirebaseReady(false);
      setTasks([]);
      setImportantDates([]);
      setAuthLoading(false);
      return;
    }

    try {
      const email = user.email?.trim().toLowerCase();
      if (!email) throw new Error('A conta autenticada não informou um e-mail.');

      // Todo usuário autenticado pode criar seu próprio perfil automaticamente.
      // Não existe mais lista prévia de e-mails autorizados.
      const accountRef = doc(db, 'contas', user.uid);
      const ownAccount = await getDoc(accountRef);
      if (ownAccount.exists()) {
        const savedEmail = String(ownAccount.data().email || '').trim().toLowerCase();
        if (savedEmail && savedEmail !== email) {
          throw new Error('O e-mail do perfil não corresponde ao e-mail autenticado.');
        }
        await setDoc(accountRef, {
          id: user.uid,
          ownerUid: user.uid,
          name: String(ownAccount.data().name || user.displayName || email.split('@')[0]),
          email,
          color: String(ownAccount.data().color || '#647cce'),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } else {
        // CADASTRO TEMPORARIAMENTE DESATIVADO:
        // Não criar automaticamente um perfil para novos usuários (inclusive Google).
        throw new Error('Novos cadastros estão temporariamente desativados. Entre com uma conta já cadastrada.');
      }

      setAuthUser(user);
      setAuthError('');
    } catch (error) {
      setAuthUser(null);
      setAuthError(`Não foi possível preparar sua conta: ${error instanceof Error ? error.message : 'verifique as regras do Firestore.'}`);
      try { await signOut(auth); } catch { /* mantém a mensagem principal */ }
    } finally {
      setAuthLoading(false);
    }
  }), []);

  async function loginWithGoogle() {
    setAuthError('');
    try {
      await prepareLocalAuthPersistence();
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Não foi possível entrar com o Google.');
    }
  }


  async function loginWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError('');
    setAuthSubmitting(true);
    try {
      await prepareLocalAuthPersistence();
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
      setLoginPassword('');
    } catch (error) {
      const code = (error as { code?: string }).code;
      const messages: Record<string, string> = {
        'auth/invalid-email': 'Informe um endereço de e-mail válido.',
        'auth/invalid-credential': 'E-mail ou senha incorretos.',
        'auth/user-not-found': 'Não existe uma conta com esse e-mail.',
        'auth/wrong-password': 'Senha incorreta.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente novamente.',
        'auth/network-request-failed': 'Falha de conexão. Verifique sua internet.'
      };
      setAuthError(messages[code || ''] || (error instanceof Error ? error.message : 'Não foi possível entrar.'));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function sendLoginPasswordReset() {
    setAuthError('');
    const email = loginEmail.trim();
    if (!email) {
      setAuthError('Digite seu e-mail no campo acima para receber o link de recuperação.');
      return;
    }
    setAuthSubmitting(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setAuthError('');
      window.alert(`Enviamos um link para redefinir sua senha para ${email}. Verifique também a caixa de spam.`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const messages: Record<string, string> = {
        'auth/invalid-email': 'Informe um endereço de e-mail válido.',
        'auth/user-not-found': 'Não encontramos uma conta com esse e-mail. Confira o endereço ou faça seu cadastro.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco antes de solicitar outro link.',
        'auth/network-request-failed': 'Falha de conexão. Verifique sua internet e tente novamente.',
      };
      setAuthError(messages[code || ''] || (error instanceof Error ? error.message : 'Não foi possível enviar o link de recuperação.'));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function registerWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError('');
    const email = loginEmail.trim().toLowerCase();
    const name = registerName.trim();
    if (!name) {
      setAuthError('Informe seu nome para criar a conta.');
      return;
    }
    if (registerPassword.length < 6) {
      setAuthError('A senha deve ter pelo menos 6 caracteres.');
      return;
    }
    if (registerPassword !== registerPasswordConfirm) {
      setAuthError('As senhas não coincidem.');
      return;
    }
    setAuthSubmitting(true);
    try {
      await prepareLocalAuthPersistence();
      const credential = await createUserWithEmailAndPassword(auth, email, registerPassword);
      await updateProfile(credential.user, { displayName: name });
      await setDoc(doc(db, 'contas', credential.user.uid), {
        id: credential.user.uid,
        ownerUid: credential.user.uid,
        name,
        email,
        color: '#647cce',
        createdAt: new Date().toISOString(),
      }, { merge: true });
      setRegisterMode(false);
      setRegisterName('');
      setRegisterPassword('');
      setRegisterPasswordConfirm('');
      setLoginPassword('');
      setAuthError('');
    } catch (error) {
      const code = (error as { code?: string }).code;
      const messages: Record<string, string> = {
        'auth/email-already-in-use': 'Este e-mail já possui cadastro. Entre com sua senha ou use a recuperação de senha.',
        'auth/invalid-email': 'Informe um endereço de e-mail válido.',
        'auth/weak-password': 'Escolha uma senha com pelo menos 6 caracteres.',
        'auth/network-request-failed': 'Falha de conexão. Verifique sua internet.',
        'permission-denied': 'O Firestore bloqueou a criação do perfil. Publique as regras atualizadas do arquivo firestore.rules.',
        'firestore/permission-denied': 'O Firestore bloqueou a criação do perfil. Publique as regras atualizadas do arquivo firestore.rules.',
      };
      setAuthError(messages[code || ''] || (error instanceof Error ? error.message : 'Não foi possível concluir o cadastro.'));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function changeAccountPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage('');
    setPasswordError('');

    if (!authUser || !authUser.email) {
      setPasswordError('Não foi possível identificar o e-mail desta conta.');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('A nova senha deve ter pelo menos 6 caracteres.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('A confirmação não corresponde à nova senha.');
      return;
    }

    setPasswordSubmitting(true);
    try {
      const hasEmailPasswordProvider = authUser.providerData.some(provider => provider.providerId === 'password');
      if (hasEmailPasswordProvider) {
        if (!currentPassword) {
          setPasswordError('Informe sua senha atual para confirmar a alteração.');
          return;
        }
        const credential = EmailAuthProvider.credential(authUser.email, currentPassword);
        await reauthenticateWithCredential(authUser, credential);
        await updatePassword(authUser, newPassword);
        setPasswordMessage('Senha alterada com sucesso.');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
      } else {
        await sendPasswordResetEmail(auth, authUser.email);
        setPasswordMessage(`Enviamos um link para ${authUser.email}. Abra o e-mail para criar ou redefinir sua senha.`);
        setNewPassword('');
        setConfirmNewPassword('');
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      const messages: Record<string, string> = {
        'auth/wrong-password': 'A senha atual está incorreta.',
        'auth/invalid-credential': 'A senha atual está incorreta. Confira e tente novamente.',
        'auth/weak-password': 'A nova senha é muito fraca. Use pelo menos 6 caracteres.',
        'auth/requires-recent-login': 'Por segurança, saia da conta e entre novamente antes de alterar a senha.',
        'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente novamente.',
        'auth/network-request-failed': 'Falha de conexão. Verifique sua internet.',
      };
      setPasswordError(messages[code || ''] || (error instanceof Error ? error.message : 'Não foi possível alterar a senha.'));
    } finally {
      setPasswordSubmitting(false);
    }
  }

  async function logout() {
    try {
      await signOut(auth);
      setAuthUser(null);
      setSwitchOpen(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Não foi possível sair da conta.');
    }
  }

  // Mantém as três coleções sincronizadas em tempo real com o Firestore.
  useEffect(() => {
    if (!authUser) return;
    let active = true;
    const initialize = async () => {
      try {
        // Migra registros antigos (ownerUid) para o novo campo userId sem
        // misturar dados de outros usuários. Registros já vinculados são mantidos.
        const legacyTasks = await getDocs(query(collection(db, 'tarefas'), where('ownerUid', '==', authUser.uid)));
        const legacyDates = await getDocs(query(collection(db, 'datas_importantes'), where('ownerUid', '==', authUser.uid)));
        await Promise.all([
          ...legacyTasks.docs
            .filter(item => !item.data().userId || item.data().userId === authUser.uid)
            .map(item => updateDoc(item.ref, { userId: authUser.uid })),
          ...legacyDates.docs
            .filter(item => !item.data().userId || item.data().userId === authUser.uid)
            .map(item => updateDoc(item.ref, { userId: authUser.uid })),
        ]);
        if (!active) return;
        const accountsRef = query(collection(db, 'contas'), where('ownerUid', '==', authUser.uid));
        const stopAccounts = onSnapshot(accountsRef, snapshot => {
          const loaded = snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Account));
          setAccounts(loaded);
          setAccount(current => loaded.find(item => item.id === current.id) || loaded[0] || current);
          setFirebaseReady(true);
          setFirebaseError('');
        }, error => setFirebaseError(`Contas: ${error.message}`));
        const stopTasks = onSnapshot(query(collection(db, 'tarefas'), where('userId', '==', authUser.uid)), snapshot => {
          setTasks(snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Task)));
        }, error => setFirebaseError(`Tarefas: ${error.message}`));
        const stopDates = onSnapshot(query(collection(db, 'datas_importantes'), where('userId', '==', authUser.uid)), snapshot => {
          setImportantDates(snapshot.docs.map(item => ({ id: item.id, ...item.data() } as ImportantDate)));
        }, error => setFirebaseError(`Datas importantes: ${error.message}`));
        return () => { stopAccounts(); stopTasks(); stopDates(); };
      } catch (error) {
        setFirebaseError(error instanceof Error ? error.message : 'Não foi possível conectar ao Firebase.');
      }
    };
    let cleanup: (() => void) | undefined;
    initialize().then(stop => { cleanup = stop; });
    return () => { active = false; cleanup?.(); };
  }, [authUser?.uid]);

  const plannerTasks = tasks.filter(task => task.accountId === account.id && task.planner === activePlanner);
  const storedPlannerDates = importantDates.filter(item => item.accountId === account.id && item.planner === activePlanner);
  const displayStartYear = Math.min(today.getFullYear(), calendarMonth.getFullYear());
  const displayEndYear = Math.max(today.getFullYear(), calendarMonth.getFullYear()) + 5;
  const plannerDates = storedPlannerDates.flatMap(item => {
    if (!item.recurringForever || !item.repeatType) return [item];
    const initial = new Date(`${item.date}T12:00:00`);
    const occurrences: ImportantDate[] = [];
    const startYear = Math.max(initial.getFullYear(), displayStartYear);
    for (let year = startYear; year <= displayEndYear; year++) {
      const monthStart = item.repeatType === 'yearly' ? initial.getMonth() : 0;
      const monthEnd = item.repeatType === 'yearly' ? initial.getMonth() : 11;
      for (let month = monthStart; month <= monthEnd; month++) {
        const day = item.repeatType === 'weekly' ? 1 : initial.getDate();
        const lastDay = new Date(year, month + 1, 0).getDate();
        if (item.repeatType === 'weekly') {
          const first = new Date(year, 0, 1, 12);
          const last = new Date(year, 11, 31, 12);
          for (const cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 1)) {
            if (cursor >= initial && (item.repeatDays || []).includes(cursor.getDay())) {
              const date = dateKey(cursor);
              occurrences.push({ ...item, id: `${item.id}_${date}`, date });
            }
          }
          break;
        }
        const date = dateKey(new Date(year, month, Math.min(day, lastDay), 12));
        if (date >= item.date) occurrences.push({ ...item, id: `${item.id}_${date}`, date });
      }
    }
    return occurrences;
  });
  //const pending = plannerTasks.filter(task => !task.done);
  const completed = plannerTasks.filter(task => task.done);
  const filteredTasks = plannerTasks;
  const filteredDates = plannerDates;

  const calendarCells = (() => {
    const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const totalWeeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    return Array.from({ length: totalWeeks * 7 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = dateKey(day);
      return { day, key, inMonth: day.getMonth() === calendarMonth.getMonth(),
        tasks: plannerTasks.filter(task => task.date === key),
        dates: plannerDates.filter(item => item.date === key) };
    });
  })();

  const visibleCalendarCells = calendarView === 'Mês'
    ? calendarCells
    : calendarView === 'Semana'
      ? calendarCells.filter(cell => {
          const selected = new Date(`${selectedDate}T12:00:00`);
          const start = new Date(selected);
          start.setDate(selected.getDate() - selected.getDay());
          const end = new Date(start);
          end.setDate(start.getDate() + 6);
          return cell.day >= start && cell.day <= end;
        })
      : calendarCells.filter(cell => cell.key === selectedDate);
  const selectedDayTasks = plannerTasks.filter(task => task.date === selectedDate).sort((a,b) => a.time.localeCompare(b.time));
  const selectedDayDates = plannerDates.filter(item => item.date === selectedDate);
  const todayTasks = plannerTasks.filter(task => task.date === dateKey(today));
  const activeDaysThisMonth = new Set([...plannerTasks.map(task => task.date), ...plannerDates.map(item => item.date)].filter(value => value.startsWith(`${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth()+1).padStart(2,'0')}`))).size;
  const upcomingTasks = [...plannerTasks].filter(task => !task.done && task.date >= dateKey(today)).sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0,3);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3200);
  }

  async function toggleTask(id: string) {
    const task = tasks.find(item => item.id === id);
    if (!task) return;
    try { await updateDoc(doc(db, 'tarefas', id), { done: !task.done, updatedAt: new Date().toISOString() }); }
    catch (error) { showNotice(`Não foi possível atualizar: ${error instanceof Error ? error.message : 'erro no Firebase'}`); }
  }

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    const start = String(form.get('date') || '');
    const end = String(form.get('until') || start);
    const time = String(form.get('time') || '');
    if (!title || !start) return;
    const base = {
      title,
      time,
      category: String(form.get('category') || 'Pessoal'),
      subcategory: String(form.get('subcategory') || ''),
      professor: String(form.get('professor') || ''),
      priority: String(form.get('priority') || 'Média') as Priority,
      done: false,
      note: String(form.get('note') || ''),
      planner: activePlanner,
      accountId: account.id,
      userId: authUser!.uid,
    };
    if (editingTaskId) {
      await updateDoc(doc(db, 'tarefas', editingTaskId), { ...base, date: start, updatedAt: new Date().toISOString() });
      setEditingTaskId(null);
      setModal(null);
      showNotice('Tarefa atualizada com sucesso.');
      return;
    }
    const newTasks: Task[] = [];
    if (recurring) {
      if (end < start) {
        showNotice('A data final precisa ser igual ou posterior à data inicial.');
        return;
      }
      if (repeatType === 'weekly' && repeatDays.length === 0) {
        showNotice('Selecione pelo menos um dia da semana para repetir a tarefa.');
        return;
      }
      const cursor = new Date(`${start}T12:00:00`);
      const last = new Date(`${end}T12:00:00`);
      const initial = new Date(`${start}T12:00:00`);
      const seriesId = crypto.randomUUID();
      while (cursor <= last) {
        const matches = repeatType === 'weekly'
          ? repeatDays.includes(cursor.getDay())
          : repeatType === 'monthly'
            ? cursor.getDate() === initial.getDate()
            : cursor.getDate() === initial.getDate() && cursor.getMonth() === initial.getMonth();
        if (matches) newTasks.push({ id: crypto.randomUUID(), date: dateKey(cursor), seriesId, ...base });
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      newTasks.push({ id: crypto.randomUUID(), date: start, ...base });
    }
    if (newTasks.length === 0) {
      showNotice('Não há ocorrências dessa tarefa no período selecionado. Confira os dias da semana e as datas.');
      return;
    }
    try {
      await Promise.all(newTasks.map(task => setDoc(doc(db, 'tarefas', task.id), {
        ...task, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      })));
    } catch (error) {
      showNotice(`Erro ao salvar tarefa: ${error instanceof Error ? error.message : 'falha no Firebase'}`);
      return;
    }
    setSelectedDate(start);
    setModal(null);
    setRecurring(false);
    setRepeatDays([]);
    showNotice(recurring ? `Tarefa recorrente criada com ${newTasks.length} ocorrência(s).` : 'Tarefa adicionada com sucesso.');
  }

  async function addImportantDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    const start = String(form.get('date') || '');
    const end = recurring && !repeatForever ? String(form.get('until') || start) : start;
    if (!title || !start) return;
    if (recurring && !repeatForever && end < start) {
      showNotice('A data final precisa ser igual ou posterior à data inicial.');
      return;
    }
    if (recurring && repeatType === 'weekly' && repeatDays.length === 0) {
      showNotice('Selecione pelo menos um dia da semana para repetir a data.');
      return;
    }
    const base = {
      title,
      category: String(form.get('category') || 'Pessoal'),
      note: String(form.get('note') || ''),
      planner: activePlanner,
      accountId: account.id,
      userId: authUser!.uid,
    };
    const newDates: ImportantDate[] = [];
    if (recurring && repeatForever) {
      newDates.push({ id: crypto.randomUUID(), date: start, recurringForever: true, repeatType, repeatDays: [...repeatDays], ...base });
    } else if (recurring) {
      const cursor = new Date(`${start}T12:00:00`);
      const last = new Date(`${end}T12:00:00`);
      const initial = new Date(`${start}T12:00:00`);
      const seriesId = crypto.randomUUID();
      while (cursor <= last) {
        const matches = repeatType === 'weekly'
          ? repeatDays.includes(cursor.getDay())
          : repeatType === 'monthly'
            ? cursor.getDate() === initial.getDate()
            : cursor.getDate() === initial.getDate() && cursor.getMonth() === initial.getMonth();
        if (matches) newDates.push({ id: crypto.randomUUID(), date: dateKey(cursor), seriesId, ...base });
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      newDates.push({ id: crypto.randomUUID(), date: start, ...base });
    }
    if (!newDates.length) {
      showNotice('Não há ocorrências dessa data no período selecionado.');
      return;
    }
    try {
      await Promise.all(newDates.map(item => setDoc(doc(db, 'datas_importantes', item.id), {
        ...item, createdAt: new Date().toISOString()
      })));
    } catch (error) {
      showNotice(`Erro ao salvar data: ${error instanceof Error ? error.message : 'falha no Firebase'}`);
      return;
    }
    setModal(null);
    setRecurring(false);
    setRepeatForever(false);
    setRepeatDays([]);
    showNotice(recurring ? (repeatForever ? 'Data importante configurada para repetir sempre, sem data final.' : `Data importante recorrente criada com ${newDates.length} ocorrência(s).`) : 'Data importante adicionada.');
  }


  function switchAccount(next: Account) {
    setAccount(next);
    setSwitchOpen(false);
    showNotice(`Conta alterada para ${next.name}.`);
  }

  function startVoiceCommand() {
    type SpeechRecognitionResultLike = { 0: { transcript: string } };
    type SpeechRecognitionEventLike = { results: ArrayLike<SpeechRecognitionResultLike> };
    type SpeechRecognitionLike = {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onresult: ((event: SpeechRecognitionEventLike) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const speechWindow = window as Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      showNotice('Seu navegador não oferece reconhecimento de voz. Tente no Chrome ou Edge.');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setListening(true);
    recognition.onresult = (event) => {
      const spoken = event.results[0][0].transcript;
      setVoiceDraft(parseVoiceTask(spoken, activePlanner));
    };
    recognition.onerror = () => {
      setListening(false);
      showNotice('Não consegui reconhecer sua fala. Tente novamente.');
    };
    recognition.onend = () => setListening(false);
    try { recognition.start(); } catch { setListening(false); showNotice('Não foi possível iniciar o microfone. Verifique a permissão do navegador.'); }
  }

  async function confirmVoiceTask() {
    if (!voiceDraft) return;
    const task: Task = {
      id: crypto.randomUUID(), title: voiceDraft.title, date: voiceDraft.date, time: voiceDraft.time,
      category: voiceDraft.planner === 'Pessoal' ? 'Pessoal' : 'Trabalho',
      priority: 'Média', done: false, note: '', planner: voiceDraft.planner, accountId: account.id, userId: authUser!.uid,
    };
    try { await setDoc(doc(db, 'tarefas', task.id), { ...task, createdAt: new Date().toISOString() }); }
    catch (error) { showNotice(`Erro ao salvar tarefa: ${error instanceof Error ? error.message : 'falha no Firebase'}`); return; }
    setVoiceDraft(null);
    showNotice('Tarefa criada por comando de voz.');
  }

  function openTaskModal() {
    setEditingTaskId(null);
    setTaskCategorySelection(activePlanner === 'Profissional' ? (professionalCategories[0]?.name || '') : 'Pessoal');
    setRecurring(false);
    setRepeatDays([]);
    setRepeatType('weekly');
    setTaskStartDate(selectedDate);
    setRepeatUntil(selectedDate);
    setModal('task');
  }

  function openImportantDateModal() {
    setRecurring(false);
    setRepeatDays([]);
    setRepeatType('yearly');
    setRepeatUntil(selectedDate);
    setModal('date');
  }

  function editTask(task: Task) {
    setEditingTaskId(task.id);
    setTaskCategorySelection(task.category);
    setTaskStartDate(task.date);
    setRepeatUntil(task.date);
    setRecurring(false);
    setRepeatDays([]);
    setModal('task');
  }

  async function deleteTask(task: Task) {
    if (!window.confirm(`Excluir a tarefa "${task.title}"?`)) return;
    try { await deleteDoc(doc(db, 'tarefas', task.id)); showNotice('Tarefa excluída.'); }
    catch (error) { showNotice(`Erro ao excluir: ${error instanceof Error ? error.message : 'falha no Firebase'}`); }
  }

  function toggleRepeatDay(day: number) {
    setRepeatDays(old => old.includes(day) ? old.filter(value => value !== day) : [...old, day]);
  }

  const currentCategories = activePlanner === 'Profissional' ? professionalCategories : personalCategories;
  const setCurrentCategories = activePlanner === 'Profissional' ? setProfessionalCategories : setPersonalCategories;
  const currentDateCategories = activePlanner === 'Profissional' ? professionalDateCategories : personalDateCategories;
  const setCurrentDateCategories = activePlanner === 'Profissional' ? setProfessionalDateCategories : setPersonalDateCategories;

  function saveCategoryDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = categoryNameDraft.trim();
    if (!name) return;
    if (categoryDialog === 'category') {
      if (configCategoryType === 'Tarefas') {
        if (currentCategories.some(item => item.name.toLowerCase() === name.toLowerCase())) { showNotice('Essa categoria já existe.'); return; }
        setCurrentCategories(old => [...old, { name, subcategories: [] }]);
      } else {
        if (currentDateCategories.some(item => item.toLowerCase() === name.toLowerCase())) { showNotice('Essa categoria já existe.'); return; }
        setCurrentDateCategories(old => [...old, name]);
      }
      setConfigCategory(name);
    } else if (categoryDialog === 'subcategory' && configCategory) {
      setCurrentCategories(old => old.map(item => item.name === configCategory && !item.subcategories.some(sub => sub.toLowerCase() === name.toLowerCase()) ? { ...item, subcategories: [...item.subcategories, name] } : item));
    }
    setCategoryNameDraft('');
    setCategoryDialog(null);
  }

  if (authLoading) return <div className="auth-screen"><div className="auth-card"><img className="auth-brand-logo" src={plannerLogo} alt="Planner — Organize seu dia" /><h1>Planner</h1><p>Verificando sua sessão...</p><div className="auth-spinner"/></div></div>;

  if (!authUser) return <div className="auth-screen">
    <section className="auth-card">
      <img className="auth-brand-logo" src={plannerLogo} alt="Planner — Organize seu dia" />
      
      <>
        <h1>{registerMode ? 'Criar cadastro' : 'Bem-vindo ao Planner'}</h1>
        <p>{registerMode ? 'Preencha seus dados para criar sua conta gratuitamente.' : 'Entre com seu e-mail e senha ou continue com sua conta Google.'}</p>
        <form className="auth-form" onSubmit={registerMode ? registerWithEmail : loginWithEmail}>
          {registerMode && <><label htmlFor="register-name">Nome</label><input id="register-name" type="text" autoComplete="name" placeholder="Seu nome" value={registerName} onChange={event => setRegisterName(event.target.value)} required /></>}
          <label htmlFor="login-email">E-mail</label>
          <input id="login-email" type="email" autoComplete="username" placeholder="seuemail@exemplo.com" value={loginEmail} onChange={event => setLoginEmail(event.target.value)} required />
          <label htmlFor="login-password">Senha</label>
          <input id="login-password" type="password" autoComplete={registerMode ? 'new-password' : 'current-password'} placeholder={registerMode ? 'Crie uma senha (mínimo 6 caracteres)' : 'Digite sua senha'} value={registerMode ? registerPassword : loginPassword} onChange={event => registerMode ? setRegisterPassword(event.target.value) : setLoginPassword(event.target.value)} required />
          {!registerMode && <button className="forgot-password-button" type="button" onClick={sendLoginPasswordReset} disabled={authSubmitting}>Esqueceu sua senha?</button>}
          {registerMode && <><label htmlFor="register-password-confirm">Confirmar senha</label><input id="register-password-confirm" type="password" autoComplete="new-password" placeholder="Digite a senha novamente" value={registerPasswordConfirm} onChange={event => setRegisterPasswordConfirm(event.target.value)} required /></>}
          <button className="email-login-button" type="submit" disabled={authSubmitting}>{authSubmitting ? (registerMode ? 'Cadastrando...' : 'Entrando...') : (registerMode ? 'Criar minha conta' : 'Entrar com e-mail')}</button>
        </form>
        {/* CADASTRO TEMPORARIAMENTE DESATIVADO — manter este botão comentado para reativar depois.
        <button className="auth-mode-button" type="button" onClick={() => { setRegisterMode(!registerMode); setAuthError(''); }} disabled={authSubmitting}>{registerMode ? 'Já tenho cadastro — entrar' : 'Não tem cadastro? Criar conta'}</button>
        */}
        <div className="auth-divider"><span>ou</span></div>
        <button className="google-login-button" onClick={loginWithGoogle} disabled={authSubmitting}>
          <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.73 7.18l7.65 5.94c4.46-4.13 7.12-10.2 7.12-17.59Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.86l-7.65-5.94c-2.13 1.43-4.86 2.27-8.25 2.27-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>
          {registerMode ? 'Cadastrar com Google' : 'Entrar com Google'}
        </button>
      </>
      {authError && <p className="auth-error">{authError}</p>}
      <small className="auth-persistence-note">Sua sessão permanecerá ativa neste navegador até você clicar em Sair.</small>
    </section>
  </div>;

  return <div className={`app-shell ${activePlanner === 'Profissional' ? 'professional-theme' : 'personal-theme'}`}>
    <aside className="sidebar">
      <div className="brand"><img className="brand-logo" src={plannerLogo} alt="Planner — Organize seu dia" /></div>
      <button className={`nav-link ${section === 'Visão geral' ? 'active' : ''}`} onClick={() => setSection('Visão geral')}><span>⌂</span> Visão geral</button>
      <button className={`nav-link ${section === 'Anotações' ? 'active' : ''}`} onClick={() => setSection('Anotações')}><span>▤</span> Anotações</button>
      <button className={`nav-link ${section === 'Configurações' ? 'active' : ''}`} onClick={() => setSection('Configurações')}><span>⚙</span> Configurações</button>
      <div className="sidebar-bottom"><div className="upgrade-card"><div className="sparkle">♡</div><b>Você consegue!</b><p>Um passo de cada vez. Continue no seu caminho!</p></div><div className="sidebar-foot">✦ <span>Seu espaço, seu ritmo.</span></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">Planner <span>/</span> <b>{section}</b></div><div className="top-actions"><button className="icon-button" title="Notificações" onClick={() => showNotice('As notificações serão configuradas em uma próxima etapa.')}>♧</button><div className="account-wrap"><button className="account-button" onClick={() => setSwitchOpen(!switchOpen)}><span className="avatar" style={{ background: account.color }}>{account.name.charAt(0).toUpperCase()}</span><span className="account-name"><b>{authUser?.displayName || account.name}</b><small>{activePlanner === 'Pessoal' ? 'Planner pessoal' : 'Planner profissional'}</small></span><span className="chevron">⌄</span></button>{switchOpen && <div className="account-menu"><div className="menu-heading">TROCAR DE CONTA</div>{accounts.map(item => <button key={item.id} className="account-option" onClick={() => switchAccount(item)}><span className="avatar small" style={{ background: item.color }}>{item.name.charAt(0).toUpperCase()}</span><span><b>{item.name}</b><small>{item.email}</small></span>{item.id === account.id && <em>✓</em>}</button>)}<div className="account-menu-divider"/><div className="signed-user"><span>{authUser?.displayName || authUser?.email}</span><small>Conta autenticada</small></div><button className="logout-button" onClick={logout}>↪ Sair</button></div>}</div></div></header>

      <div className="content">      {!firebaseReady && <p className="firebase-status">Conectando ao Firebase...</p>}       {firebaseError && <p className="firebase-error">Falha na conexão com o Firebase: {firebaseError}</p>}
        <section className="welcome-row"><div><div className="eyebrow">{today.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div><h1>{section === 'Visão geral' ? `Olá, ${account.name}!` : section}<span className="wave">✦</span></h1><p className="muted">{section === 'Visão geral' ? 'Pequenos passos todos os dias fazem uma grande diferença.' : section === 'Anotações' ? 'Guarde suas tarefas e datas importantes em um só lugar.' : 'Personalize as categorias do planner selecionado.'}</p><div className={`planner-switch ${activePlanner === 'Profissional' ? 'professional' : 'personal'}`}><button className={activePlanner === 'Pessoal' ? 'active' : ''} onClick={() => { setActivePlanner('Pessoal'); setConfigCategory(personalCategories[0]?.name || ''); setTaskCategorySelection(personalCategories[0]?.name || ''); }}>◉ Planner pessoal</button><button className={activePlanner === 'Profissional' ? 'active' : ''} onClick={() => { setActivePlanner('Profissional'); setConfigCategory(professionalCategories[0]?.name || ''); setTaskCategorySelection(professionalCategories[0]?.name || ''); }}>▣ Planner profissional</button></div></div><div className="annotation-actions">{section === 'Anotações' && <button className={`voice-button ${listening ? 'listening' : ''}`} onClick={startVoiceCommand}><span>🎙</span>{listening ? 'Ouvindo...' : 'Comando de voz'}</button>}{section === 'Anotações' && <><button className="secondary-action" onClick={openImportantDateModal}>＋ Data importante</button><button className="primary-button" onClick={openTaskModal}>＋ Nova tarefa</button></>}</div></section>

        {section === 'Visão geral' && <>
          <div className="dashboard-main-grid">
            <section className="panel calendar-panel">
              <div className="panel-header calendar-heading"><div className="calendar-title-wrap"><span className="calendar-title-icon">▦</span><div><h2>Calendário</h2><p>Visualize suas tarefas e datas importantes.</p></div></div>
                <div className="calendar-toolbar"><div className="calendar-view-switch">{(['Mês','Semana','Dia'] as const).map(view => <button key={view} className={calendarView === view ? 'active' : ''} onClick={() => setCalendarView(view)}>{view}</button>)}</div><div className="calendar-controls"><button aria-label="Período anterior" onClick={() => { const d = new Date(`${selectedDate}T12:00:00`); d.setDate(d.getDate() + (calendarView === 'Mês' ? -new Date(d.getFullYear(),d.getMonth(),1).getDate() : calendarView === 'Semana' ? -7 : -1)); setSelectedDate(dateKey(d)); setCalendarMonth(new Date(d.getFullYear(),d.getMonth(),1)); }}>‹</button><strong>{calendarView === 'Mês' ? calendarMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : calendarView === 'Semana' ? `Semana de ${new Date(`${selectedDate}T12:00:00`).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})}` : dateLabel(selectedDate)}</strong><button aria-label="Próximo período" onClick={() => { const d = new Date(`${selectedDate}T12:00:00`); d.setDate(d.getDate() + (calendarView === 'Mês' ? 32 : calendarView === 'Semana' ? 7 : 1)); setSelectedDate(dateKey(d)); setCalendarMonth(new Date(d.getFullYear(),d.getMonth(),1)); }}>›</button><button className="today-button" onClick={() => { setCalendarMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDate(dateKey(today)); }}>Hoje</button></div></div>
              </div>
              {calendarView !== 'Dia' && <div className="calendar-grid calendar-weekdays">{weekdays.map(day => <div key={day}>{day}</div>)}</div>}
              <div className={`calendar-grid ${calendarView !== 'Mês' ? 'calendar-focused-view' : ''} ${calendarView === 'Dia' ? 'calendar-day-view' : ''}`}>{visibleCalendarCells.map(cell => <button key={cell.key} className={`calendar-day ${!cell.inMonth ? 'outside-month' : ''} ${cell.key === dateKey(today) ? 'is-today' : ''} ${cell.key === selectedDate ? 'is-selected' : ''}`} onClick={() => { setSelectedDate(cell.key); setTaskStartDate(cell.key); }}>
                <span className="calendar-number">{cell.day.getDate()}</span><span className="calendar-dots">{cell.tasks.slice(0, 3).map(task => <i key={task.id} className={task.done ? 'dot-done' : 'dot-task'} title={task.title}/>)}{cell.dates.slice(0, 2).map(item => <i key={item.id} className="dot-date" title={item.title}/>)}</span>
                <span className="calendar-event-labels">{cell.tasks.slice(0, calendarView === 'Mês' ? 2 : 10).map(task => <small key={task.id} className={`calendar-task-label ${task.done ? 'completed' : ''}`}>{task.done ? '✓ ' : ''}{task.title}</small>)}{cell.dates.slice(0, calendarView === 'Mês' ? 1 : 5).map(item => <small key={item.id} className="calendar-date-label">☆ {item.title}</small>)}</span>
                {cell.tasks.length + cell.dates.length > (calendarView === 'Mês' ? 3 : 15) && <small>+{cell.tasks.length + cell.dates.length - (calendarView === 'Mês' ? 3 : 15)} mais</small>}
              </button>)}</div>
              <div className="calendar-footer"><span><i className="dot-task"/> Tarefas</span><span><i className="dot-date"/> Datas importantes</span></div>
              <section className="selected-day-panel"><div className="selected-day-heading"><div><h3>{dateLabel(selectedDate)}</h3><p>Atividades e datas deste dia</p></div><button onClick={openTaskModal}>＋ Nova tarefa</button></div>
                {selectedDayTasks.length === 0 && selectedDayDates.length === 0 ? <p className="selected-day-empty">Nenhuma tarefa ou data cadastrada para este dia.</p> : <div className="selected-day-list">{selectedDayTasks.map(task => <article className={`selected-day-item ${task.done ? 'is-done' : ''}`} key={task.id}><button className={`check-circle ${task.done ? 'checked' : ''}`} onClick={() => toggleTask(task.id)} aria-label={task.done ? 'Marcar como pendente' : 'Concluir tarefa'}>{task.done ? '✓' : ''}</button><div className="task-info"><b>{task.title}</b><div className="task-meta"><span>{task.time || 'Sem horário'}</span><span className="category-tag">{task.category}</span><span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority}</span></div>{task.note && <p>{task.note}</p>}</div><div className="task-row-actions"><button onClick={() => editTask(task)} aria-label="Editar tarefa" title="Editar">✎</button><button onClick={() => deleteTask(task)} aria-label="Excluir tarefa" title="Excluir">⌫</button></div></article>)}{selectedDayDates.map(item => <article className="selected-day-item important-day-item" key={item.id}><span className="important-star">☆</span><div className="task-info"><b>{item.title}</b><div className="task-meta"><span>Data importante</span><span className="category-tag">{item.category}</span></div>{item.note && <p>{item.note}</p>}</div></article>)}</div>}
              </section>
            </section>
            <aside className="dashboard-side-column">
              <section className="upcoming-panel"><div className="upcoming-heading"><span>✓</span><b>Próximas atividades</b><button onClick={() => setSection('Anotações')}>Ver todas →</button></div>
                <div className="upcoming-list">{upcomingTasks.length ? upcomingTasks.map(task => <div className="upcoming-row" key={task.id}><button className="upcoming-check" aria-label="Concluir tarefa" onClick={() => toggleTask(task.id)}></button><div><b>{task.title}</b><small>{dateLabel(task.date)}{task.time ? ` · ${task.time}` : ''}</small></div><span>{new Date(`${task.date}T12:00:00`).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</span></div>) : <p className="upcoming-empty">Nenhuma atividade pendente. Que tal adicionar uma tarefa?</p>}</div>
              </section>
              <section className="motivation-card"><div className="target-icon">◎</div><div><b>Você está no caminho certo!</b><p>Pequenos passos também são conquistas.</p></div></section>
              <section className="upcoming-dates-card"><div className="upcoming-dates-heading"><span>★</span><b>Datas importantes</b><button onClick={() => setSection('Anotações')}>Ver todas →</button></div>{[...plannerDates].filter(item => item.date >= dateKey(today)).sort((a,b) => a.date.localeCompare(b.date)).slice(0,2).map(item => <div className="upcoming-date-row" key={item.id}><strong>{new Date(`${item.date}T12:00:00`).getDate()}</strong><div><b>{item.title}</b><small>{dateLabel(item.date)}</small></div></div>)}{plannerDates.filter(item => item.date >= dateKey(today)).length === 0 && <p className="upcoming-empty">Nenhuma data cadastrada.</p>}<button className="add-date-link" onClick={openImportantDateModal}>＋ Adicionar data</button></section>
            </aside>
          </div>
          <section className="dashboard-stats-row">
            <article className="dashboard-stat"><span className="dashboard-stat-icon blue-stat">▦</span><div><strong>{activeDaysThisMonth}</strong><b>Dias com atividades</b></div></article>
            <article className="dashboard-stat"><span className="dashboard-stat-icon lilac-stat">✓</span><div><strong>{todayTasks.length}</strong><b>Tarefas hoje</b></div></article>
            <article className="dashboard-stat"><span className="dashboard-stat-icon yellow-stat">☆</span><div><strong>{completed.length}</strong><b>Tarefas concluídas</b></div></article>
            <article className="dashboard-encouragement"><span>☆</span><div><b>Continue assim!</b><p>Você está organizando muito bem o seu dia.</p></div></article>
          </section>
        </>}

        {section === 'Configurações' && <section className="panel annotations-panel">
          <div className="annotation-toolbar"><div><h2>Configurações do planner</h2><p>Gerencie as categorias e subcategorias do planner selecionado.</p></div></div>
          <div className="annotation-section account-security-section">
            <div className="annotation-section-title"><h3>Segurança da conta</h3></div>
            <div className="password-settings-card">
              <div className="password-settings-heading">
                <div><b>Alterar senha</b><p>Atualize a senha utilizada para acessar seu Planner.</p></div>
                <span aria-hidden="true">🔒</span>
              </div>
              {authUser?.providerData.some(provider => provider.providerId === 'password') ? (
                <form className="password-change-form" onSubmit={changeAccountPassword}>
                  <label>Senha atual<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} placeholder="Digite sua senha atual" required /></label>
                  <div className="form-two">
                    <label>Nova senha<input type="password" autoComplete="new-password" minLength={6} value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="Mínimo de 6 caracteres" required /></label>
                    <label>Confirmar nova senha<input type="password" autoComplete="new-password" minLength={6} value={confirmNewPassword} onChange={event => setConfirmNewPassword(event.target.value)} placeholder="Repita a nova senha" required /></label>
                  </div>
                  <button className="primary-button" type="submit" disabled={passwordSubmitting}>{passwordSubmitting ? 'Alterando...' : 'Salvar nova senha'}</button>
                </form>
              ) : (
                <div className="password-change-form">
                  <p>Esta conta utiliza o Google para entrar. Para criar ou redefinir uma senha, enviaremos um link para o seu e-mail.</p>
                  <button className="primary-button" type="button" disabled={passwordSubmitting} onClick={() => { setPasswordError(''); setPasswordMessage(''); setPasswordSubmitting(true); sendPasswordResetEmail(auth, authUser?.email || '').then(() => setPasswordMessage(`Enviamos um link para ${authUser?.email}. Confira sua caixa de entrada.`)).catch(error => setPasswordError(error instanceof Error ? error.message : 'Não foi possível enviar o e-mail.')).finally(() => setPasswordSubmitting(false)); }}>{passwordSubmitting ? 'Enviando...' : 'Enviar link para redefinir senha'}</button>
                </div>
              )}
              {passwordError && <p className="password-feedback error">{passwordError}</p>}
              {passwordMessage && <p className="password-feedback success">{passwordMessage}</p>}
            </div>
          </div>
          <div className="annotation-section settings-categories-section">
            <div className="annotation-section-title"><div><h3>Categorias</h3><p>Gerencie separadamente as categorias de tarefas e de datas importantes.</p></div></div>
            <div className="settings-category-tabs" role="tablist" aria-label="Tipo de categoria">
              {(['Tarefas', 'Datas importantes'] as const).map(type => <button type="button" role="tab" aria-selected={configCategoryType === type} key={type} className={configCategoryType === type ? 'active' : ''} onClick={() => { setConfigCategoryType(type); setConfigCategory(''); }}>{type === 'Tarefas' ? 'Categorias de tarefas' : 'Categorias de datas importantes'}</button>)}
            </div>
            <div className="settings-category-toolbar"><div><b>{configCategoryType === 'Tarefas' ? 'Categorias das tarefas' : 'Categorias das datas importantes'}</b><span>{configCategoryType === 'Tarefas' ? 'Classifique atividades por assunto e use subcategorias quando precisar.' : 'Organize aniversários, datas comemorativas, feriados e eventos.'}</span></div><button type="button" className="primary-button" onClick={() => { setCategoryNameDraft(''); setCategoryDialog('category'); }}>＋ Nova categoria</button></div>
            {configCategoryType === 'Tarefas' ? <div className="settings-category-layout">
              <div className="settings-category-list">{currentCategories.map(category => <div className={`settings-category-row ${configCategory === category.name ? 'selected' : ''}`} key={category.name}><button type="button" onClick={() => setConfigCategory(category.name)}>{category.name}<small>{category.subcategories.length} subcategoria(s)</small></button><button type="button" aria-label={`Excluir ${category.name}`} onClick={() => { if (window.confirm(`Excluir a categoria "${category.name}"?`)) { setCurrentCategories(old => old.filter(c => c.name !== category.name)); if (configCategory === category.name) setConfigCategory(''); } }}>⌫</button></div>)}{currentCategories.length === 0 && <p className="settings-empty">Nenhuma categoria cadastrada.</p>}</div>
              <div className="settings-subcategories"><h3>{configCategory || 'Selecione uma categoria'}</h3><p>As subcategorias ajudam a detalhar melhor cada tarefa.</p>{currentCategories.find(c => c.name === configCategory)?.subcategories.map(sub => <div className="settings-sub-row" key={sub}><span>{sub}</span><button type="button" onClick={() => setCurrentCategories(old => old.map(c => c.name === configCategory ? {...c, subcategories:c.subcategories.filter(x => x !== sub)} : c))}>Excluir</button></div>)}{configCategory && <button className="secondary-action" type="button" onClick={() => { setCategoryNameDraft(''); setCategoryDialog('subcategory'); }}>＋ Adicionar subcategoria</button>}</div>
            </div> : <div className="settings-category-list settings-date-category-list">{currentDateCategories.map(category => <div className="settings-category-row" key={category}><button type="button" onClick={() => setConfigCategory(category)}>{category}<small>Categoria de data importante</small></button><button type="button" aria-label={`Excluir ${category}`} onClick={() => { if (window.confirm(`Excluir a categoria "${category}"?`)) setCurrentDateCategories(old => old.filter(item => item !== category)); }}>⌫</button></div>)}{currentDateCategories.length === 0 && <p className="settings-empty">Nenhuma categoria cadastrada.</p>}</div>}
          </div>
        </section>}

        {section === 'Anotações' && <section className="panel annotations-panel"><div className="annotation-toolbar"><div><h2>Suas anotações</h2><p>Adicione tarefas, repetições e datas que deseja guardar.</p></div><div className="filter-pills">{(['Tudo', 'Tarefas', 'Datas importantes'] as const).map(value => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value}</button>)}</div></div>
          {(filter === 'Tudo' || filter === 'Tarefas') && <div className="annotation-section"><div className="annotation-section-title"><h3>Tarefas</h3><span>{filteredTasks.length}</span><button onClick={openTaskModal}>＋ Nova tarefa</button></div>{filteredTasks.length === 0 ? <p className="quiet-empty">Você ainda não adicionou tarefas.</p> : <div className="annotation-list">{[...filteredTasks].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).map(task => <article className={`task-item ${task.done ? 'is-done' : ''}`} key={task.id}><button className={`check-circle ${task.done ? 'checked' : ''}`} onClick={() => toggleTask(task.id)}>{task.done ? '✓' : ''}</button><div className="task-info"><b>{task.title}</b><div className="task-meta"><span>{dateLabel(task.date)}{task.time ? ` · ${task.time}` : ''}</span><span className="category-tag">{task.category}</span>{task.seriesId && <span className="repeat-tag">↻ Recorrente</span>}</div>{task.note && <p>{task.note}</p>}</div><span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority}</span><div className="task-row-actions"><button onClick={() => editTask(task)} aria-label="Editar tarefa" title="Editar">✎</button><button onClick={() => deleteTask(task)} aria-label="Excluir tarefa" title="Excluir">⌫</button></div></article>)}</div>}</div>}
          {(filter === 'Tudo' || filter === 'Datas importantes') && <div className="annotation-section"><div className="annotation-section-title"><h3>Datas importantes</h3><span>{filteredDates.length}</span><button onClick={openImportantDateModal}>＋ Nova data</button></div>{filteredDates.length === 0 ? <p className="quiet-empty">Você ainda não adicionou datas importantes.</p> : <div className="important-list annotation-list">{[...filteredDates].sort((a, b) => a.date.localeCompare(b.date)).map(item => <article className="important-item" key={item.id}><div className="date-tile"><b>{new Date(`${item.date}T12:00:00`).getDate()}</b><span>{new Date(`${item.date}T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span></div><div><b>{item.title}</b><small>{dateLabel(item.date)} · {item.category}{item.seriesId ? ' · ↻ Recorrente' : ''}</small>{item.note && <p>{item.note}</p>}</div></article>)}</div>}</div>}
        </section>}
        <footer className="footer-note">Seu espaço, seu ritmo <span>✦</span></footer>
      </div>
    </main>

    {notice && <div className="toast">✓ &nbsp;{notice}<button onClick={() => setNotice('')}>×</button></div>}

    {voiceDraft && <div className="modal-backdrop"><section className={`task-modal voice-confirm ${voiceDraft.planner === 'Profissional' ? 'professional-modal' : ''}`}><div className="modal-top"><div><span className="eyebrow">COMANDO DE VOZ</span><h2>Confirme sua tarefa</h2></div><span className="voice-confirm-icon">🎙</span></div><p className="voice-summary">Entendi que você precisa:</p><div className="voice-preview"><b>{voiceDraft.title}</b><span>{dateLabel(voiceDraft.date)}{voiceDraft.time ? ` · ${voiceDraft.time}` : ' · Sem horário informado'}</span><small>{voiceDraft.planner === 'Pessoal' ? 'Planner pessoal' : 'Planner profissional'}</small></div><button className="primary-button confirm-voice-button" onClick={confirmVoiceTask}>✓ Confirmar tarefa</button></section></div>}

    {modal === 'task' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}><form className="task-modal" onSubmit={addTask}><div className="modal-top"><div><span className="eyebrow">ORGANIZE SEU DIA</span><h2>{editingTaskId ? 'Editar tarefa' : 'Nova tarefa'}</h2></div><button type="button" className="close-modal" onClick={() => { setModal(null); setEditingTaskId(null); }}>×</button></div><label>Título da tarefa<input name="title" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.title : ''} placeholder="Ex.: Reunião de planejamento" required autoFocus/></label><div className="form-two"><label>Data de início<input name="date" type="date" value={taskStartDate} onChange={event => { setTaskStartDate(event.target.value); if (repeatUntil < event.target.value) setRepeatUntil(event.target.value); }} required/></label><label>Horário<input name="time" type="time" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.time : ''}/></label></div><div className="form-two"><label>Categoria<select name="category" value={taskCategorySelection} onChange={event => setTaskCategorySelection(event.target.value)}>{currentCategories.map(item => item.name).map(item => <option key={item}>{item}</option>)}</select></label><label>Prioridade<select name="priority" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.priority : 'Média'}><option>Baixa</option><option selected>Média</option><option>Alta</option></select></label></div>
      {(currentCategories.find(item => item.name === taskCategorySelection)?.subcategories.length || 0) > 0 && <div className="form-two"><label>Subcategoria<select name="subcategory" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.subcategory || '' : ''}><option value="">Nenhum</option>{(currentCategories.find(item => item.name === taskCategorySelection)?.subcategories || []).map(item => <option key={item}>{item}</option>)}</select></label><label>Detalhe adicional<input name="professor" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.professor || '' : ''} placeholder="Opcional"/></label></div>}
      <label>Anotações<textarea name="note" defaultValue={editingTaskId ? tasks.find(task => task.id === editingTaskId)?.note : ''} placeholder="Detalhes adicionais (opcional)" rows={2}/></label>
      {!editingTaskId && <div className="recurrence-box"><label className="recurrence-toggle"><input type="checkbox" checked={recurring} onChange={event => { setRecurring(event.target.checked); setRepeatDays([]); }}/> <span><b>Repetir esta tarefa</b><small>Configurar uma tarefa recorrente semanalmente</small></span></label>
        {recurring && <div className="recurrence-options"><label>Frequência<select value={repeatType} onChange={event => setRepeatType(event.target.value as 'weekly' | 'monthly' | 'yearly')}><option value="weekly">Semanalmente</option><option value="monthly">Mensalmente</option><option value="yearly">Anualmente</option></select></label>{repeatType === 'weekly' && <><span className="field-caption">Repetir toda semana nos dias:</span><div className="weekday-picker">{weekdays.map((day, index) => <button type="button" key={day} className={repeatDays.includes(index) ? 'day-selected' : ''} onClick={() => toggleRepeatDay(index)}>{day}</button>)}</div></>}{repeatType === 'monthly' && <small className="recurrence-hint">A tarefa será repetida todo dia {Number(taskStartDate.slice(8, 10))} de cada mês.</small>}{repeatType === 'yearly' && <small className="recurrence-hint">A tarefa será repetida todo dia {Number(taskStartDate.slice(8, 10))} de {new Date(`${taskStartDate}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long' })}, todos os anos.</small>}<label>Repetir até<input name="until" type="date" min={taskStartDate} value={repeatUntil} onChange={event => setRepeatUntil(event.target.value)}/></label><small className="recurrence-hint">{repeatType === 'weekly' ? 'Serão criadas tarefas nos dias da semana selecionados.' : repeatType === 'monthly' ? 'Serão criadas tarefas no mesmo dia de cada mês, até a data final.' : 'Serão criadas tarefas na mesma data, todos os anos, até a data final.'}</small></div>}
      </div>}<div className="modal-actions"><button type="button" className="cancel-button" onClick={() => { setModal(null); setEditingTaskId(null); }}>Cancelar</button><button className="primary-button" type="submit">{editingTaskId ? 'Salvar alterações' : 'Salvar tarefa'}</button></div></form></div>}

    {modal === 'date' && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}><form className="task-modal" onSubmit={addImportantDate}><div className="modal-top"><div><span className="eyebrow">GUARDE A DATA</span><h2>Nova data importante</h2></div><button type="button" className="close-modal" onClick={() => setModal(null)}>×</button></div><label>Nome da data<input name="title" placeholder="Ex.: Aniversário, reunião, evento..." required autoFocus/></label><div className="form-two"><label>Data<input name="date" type="date" defaultValue={selectedDate} onChange={event => { if (repeatUntil < event.target.value) setRepeatUntil(event.target.value); }} required/></label><label>Categoria<select name="category" defaultValue={currentDateCategories[0] || 'Outros'}>{currentDateCategories.map(category => <option key={category} value={category}>{category}</option>)}</select></label></div><div className="recurrence-box"><label className="recurrence-toggle"><input type="checkbox" checked={recurring} onChange={event => { setRecurring(event.target.checked); setRepeatDays([]); }}/> <span><b>Repetir esta data</b><small>Escolha a frequência da repetição</small></span></label>{recurring && <div className="recurrence-options"><label>Frequência<select value={repeatType} onChange={event => setRepeatType(event.target.value as 'weekly' | 'monthly' | 'yearly')}><option value="weekly">Semanalmente</option><option value="monthly">Mensalmente</option><option value="yearly">Anualmente</option></select></label>{repeatType === 'weekly' && <><span className="field-caption">Repetir toda semana nos dias:</span><div className="weekday-picker">{weekdays.map((day, index) => <button type="button" key={day} className={repeatDays.includes(index) ? 'day-selected' : ''} onClick={() => toggleRepeatDay(index)}>{day}</button>)}</div></>}{repeatType === 'monthly' && <small className="recurrence-hint">A data será repetida no mesmo dia de cada mês.</small>}{repeatType === 'yearly' && <small className="recurrence-hint">A data será repetida no mesmo dia e mês, todos os anos.</small>}<label className="recurrence-toggle"><input type="checkbox" checked={repeatForever} onChange={event => setRepeatForever(event.target.checked)}/> <span><b>Repetir sempre</b><small>Sem data final: a data continuará se repetindo enquanto você usar o Planner.</small></span></label>{!repeatForever && <label>Repetir até<input name="until" type="date" min={selectedDate} value={repeatUntil} onChange={event => setRepeatUntil(event.target.value)}/></label>}</div>}</div><label>Observações<textarea name="note" rows={3} placeholder="Detalhes adicionais (opcional)"/></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setModal(null)}>Cancelar</button><button className="primary-button" type="submit">Salvar data</button></div></form></div>}
    {categoryDialog && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setCategoryDialog(null); }}><form className="task-modal category-dialog" onSubmit={saveCategoryDialog}><div className="modal-top"><div><span className="eyebrow">CONFIGURAÇÕES DO PLANNER</span><h2>{categoryDialog === 'category' ? 'Adicionar categoria' : 'Adicionar subcategoria'}</h2></div><button type="button" className="close-modal" onClick={() => setCategoryDialog(null)}>×</button></div><p className="category-dialog-description">{categoryDialog === 'category' ? `A categoria ficará disponível em ${configCategoryType.toLowerCase()} do Planner ${activePlanner.toLowerCase()}.` : `A subcategoria será adicionada em “${configCategory}”.`}</p><label>Nome<input value={categoryNameDraft} onChange={event => setCategoryNameDraft(event.target.value)} placeholder={categoryDialog === 'category' ? 'Digite o nome da categoria' : 'Digite o nome da subcategoria'} required autoFocus maxLength={45}/></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setCategoryDialog(null)}>Cancelar</button><button className="primary-button" type="submit">Salvar</button></div></form></div>}

  </div>;
}
