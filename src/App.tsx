import { useEffect, useState } from 'react'
import {
  Activity, Bell, BookOpen, CalendarDays,
  ChevronRight, CircleHelp, Clock3, Database, FileText, GraduationCap,
  ClipboardList, Download, Eye, EyeOff, LayoutDashboard, LogOut, Menu, MessageCircle, MoreHorizontal, Search, Send, Sparkles, Upload, UserPlus, Users, X,
} from 'lucide-react'
import './App.css'
import './Admin.css'
import './StudentManager.css'
import './Auth.css'
import './Imports.css'
import './Assistant.css'
import './Navigation.css'

type View = 'Overview' | 'My courses' | 'Assignments' | 'Learning materials' | 'Timetable' | 'Records' | 'Add student' | 'Import students' | 'Import data' | 'Assistant'
type Connection = 'checking' | 'connected' | 'disconnected'
type StaffUser = { staff_id: number; full_name: string; email: string; role: 'admin' | 'staff' }
type StudentUser = { student_id: number; full_name: string; institution_student_id: string }
type StudentRecord = {
  student_id: number
  roll_number: string | null
  institution_student_id: string | null
  first_name: string
  last_name: string
  email: string | null
  admission_date: string | null
  current_semester: number
  program_code: string | null
  has_account?: boolean
}
type Course = { code: string; name: string; faculty: string; room: string; days: string; time: string; meetings: { day: number; startsAt: string; endsAt: string }[]; attendance: number; grade: string | null; color: string }
type Dashboard = {
  student: { name: string; usn: string; program: string; semester: string }
  attendance: number
  gpa: number
  credits: number
  courses: Course[]
  assignments: { title: string; course: string; due: string; status: string }[]
  materials: { title: string; course: string; type: string; url: string; date: string }[]
  announcements: { category: string; title: string; body: string; date: string; color: string }[]
}

const nav: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'My courses', icon: BookOpen },
  { label: 'Assignments', icon: ClipboardList },
  { label: 'Learning materials', icon: FileText },
  { label: 'Timetable', icon: CalendarDays },
  { label: 'Records', icon: Database },
  { label: 'Add student', icon: UserPlus },
  { label: 'Import students', icon: Upload },
  { label: 'Import data', icon: Upload },
  { label: 'Assistant', icon: Sparkles },
]
const studentNav: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'My courses', icon: BookOpen },
  { label: 'Assignments', icon: ClipboardList },
  { label: 'Learning materials', icon: FileText },
  { label: 'Timetable', icon: CalendarDays },
  { label: 'Records', icon: Database },
  { label: 'Assistant', icon: Sparkles },
]
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

export default function App() {
  const [view, setView] = useState<View>('Overview')
  const [data, setData] = useState<Dashboard | null>(null)
  const [connection, setConnection] = useState<Connection>('checking')
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [studentUser, setStudentUser] = useState<StudentUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authRole, setAuthRole] = useState<'staff' | 'student'>('student')
  const [connectionMessage, setConnectionMessage] = useState('')
  const [authError, setAuthError] = useState('')
  const [adminRegistrationOpen, setAdminRegistrationOpen] = useState(false)
  const [adminRegistrationMessage, setAdminRegistrationMessage] = useState('')
  const [authenticatorQr, setAuthenticatorQr] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [usn, setUsn] = useState('')
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'not-found' | 'error'>('idle')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([
      fetch('/api/health'),
      fetch('/api/auth/session'),
      fetch('/api/student/auth/session'),
      fetch('/api/auth/status'),
    ]).then(async ([healthResponse, sessionResponse, studentSessionResponse, authStatusResponse]) => {
      if (!active) return
      setConnection(healthResponse.ok ? 'connected' : 'disconnected')
      setConnectionMessage(healthResponse.ok ? '' : healthResponse.status === 503
        ? 'PostgreSQL is unavailable at localhost:5432. Confirm PostgreSQL 18 is running on the configured port.'
        : 'The API server is unavailable. Start the backend server and refresh this page.')
      if (authStatusResponse.ok) {
        const status = await authStatusResponse.json() as { registration_open?: boolean }
        setAdminRegistrationOpen(status.registration_open === true)
      }
      if (sessionResponse.ok) {
        const session = await sessionResponse.json() as { user: StaffUser }
        setStaffUser(session.user)
        setAuthRole('staff')
      } else if (studentSessionResponse.ok) {
        const session = await studentSessionResponse.json() as { user: StudentUser }
        const dashboardResponse = await fetch('/api/student/dashboard')
        if (dashboardResponse.ok) {
          setStudentUser(session.user)
          setData(await dashboardResponse.json() as Dashboard)
        }
      }
    }).catch(() => {
      if (active) {
        setConnection('disconnected')
        setConnectionMessage('The API server is unavailable. Start the backend server and refresh this page.')
      }
    }).finally(() => {
      if (active) setAuthReady(true)
    })
    return () => { active = false }
  }, [])

  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    try {
      const response = await fetch(authRole === 'student' ? '/api/student/auth/login' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const result = await response.json() as {
        user?: StaffUser | StudentUser
        message?: string
        account_created?: boolean
        authenticator_setup_required?: boolean
        qr_code?: string
      }
      if (!response.ok) throw new Error(result.message ?? 'Authentication failed.')
      if (result.authenticator_setup_required && result.qr_code) {
        setAuthenticatorQr(result.qr_code)
        return
      }
      if (!result.user) throw new Error(result.message ?? 'Authentication failed.')
      if (authRole === 'student') {
        const dashboardResponse = await fetch('/api/student/dashboard')
        const dashboard = await dashboardResponse.json() as Dashboard | { message?: string }
        if (!dashboardResponse.ok) throw new Error('message' in dashboard ? dashboard.message ?? 'Could not load your student workspace.' : 'Could not load your student workspace.')
        setStudentUser(result.user as StudentUser)
        setData(dashboard as Dashboard)
        setAuthenticatorQr(null)
      } else {
        setStaffUser(result.user as StaffUser)
      }
      setAuthError('')
      setView(authRole === 'student' ? 'Overview' : 'Add student')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not connect to the server.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function registerAdmin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    setAdminRegistrationMessage('')
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const result = await response.json() as { message?: string; account_created?: boolean }
      if (!response.ok || !result.account_created) throw new Error(result.message ?? 'Could not create the administrator account.')
      setAdminRegistrationOpen(false)
      setAdminRegistrationMessage('Administrator account created. Sign in to set up your authenticator.')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not connect to the server.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function logout() {
    await fetch(studentUser ? '/api/student/auth/logout' : '/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    setStaffUser(null)
    setStudentUser(null)
    setData(null)
    setView('Overview')
  }

  async function loadStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedUsn = usn.trim()
    if (!normalizedUsn) return

    setLoadState('loading')
    setData(null)
    try {
      const response = await fetch(`/api/dashboard?usn=${encodeURIComponent(normalizedUsn)}`)
      if (response.status === 404) {
        setLoadState('not-found')
        return
      }
      if (!response.ok) throw new Error('Dashboard request failed')
      setData(await response.json() as Dashboard)
      setLoadState('idle')
    } catch {
      setConnection('disconnected')
      setLoadState('error')
    }
  }

  const title = data?.student.name ?? 'Academic workspace'
  const semester = data?.student.semester ?? 'No student selected'
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())

  if (!authReady || (!staffUser && !studentUser)) {
    return <AuthGate
      loading={!authReady}
      connection={connection}
      connectionMessage={connectionMessage}
      error={authError}
      busy={authBusy}
      role={authRole}
      adminRegistrationOpen={adminRegistrationOpen}
      registrationMessage={adminRegistrationMessage}
      authenticatorQr={authenticatorQr}
      setRole={setAuthRole}
      onSubmit={authenticate}
      onRegister={registerAdmin}
    />
  }
  const visibleNav = studentUser
    ? studentNav
    : staffUser?.role === 'admin'
      ? nav
      : nav.filter((item) => item.label !== 'Import data')

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#overview" onClick={() => setView('Overview')}><span className="brand-mark"><GraduationCap size={20}/></span><span className="brand-name">Student Lifecycle OS</span></a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <nav>{visibleNav.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${view === label ? 'nav-item-active' : ''}`} onClick={() => { setView(label); setMobileOpen(false) }}><Icon size={17}/><span>{label}</span>{label === 'My courses' && data && <small>{String(data.courses.length).padStart(2, '0')}</small>}</button>)}</nav>
      <div className="sidebar-section-head"><span>MY COURSES</span><MoreHorizontal size={16}/></div>
      <div className="course-shortcuts">{data?.courses.map((course) => <button key={course.code} onClick={() => setView('My courses')}><i className={`course-dot ${course.color}`}/><b>{course.code}</b><span>{course.name}</span></button>)}</div>
      <div className="sidebar-bottom">
        <div className="database-status"><i className={`status-indicator ${connection}`}/>{connection === 'connected' ? 'PostgreSQL connected' : connection === 'checking' ? 'Checking database' : 'Database unavailable'}<button onClick={() => setView('Records')} aria-label="Database details"><ChevronRight size={15}/></button></div>
        <div className="profile-card"><span className="avatar"><Users size={15}/></span><span><b>{studentUser?.full_name ?? staffUser?.full_name}</b><small>{studentUser?.institution_student_id ?? `${staffUser?.role === 'admin' ? 'Administrator · ' : ''}${staffUser?.email}`}</small></span><button className="icon-button signout-button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={15}/></button></div>
      </div>
    </aside>
    {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)}/>}
    <main className="main-area"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={19}/></button><span>Student portal</span><ChevronRight size={14}/><b>{view}</b></div><div className="topbar-actions"><span className="term-chip"><i/>{semester}</span><InstallButton/><button className="icon-button" onClick={() => setSearchOpen(!searchOpen)} aria-label="Search"><Search size={18}/></button><button className="icon-button notification" aria-label="Notifications"><Bell size={18}/></button><span className="topbar-divider"/>{data && <span className="top-avatar">{data.student.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>}</div></header>
      {searchOpen && <div className="search-panel"><Search size={16}/><input autoFocus placeholder="Search courses, assignments, announcements..."/><button className="icon-button" onClick={() => setSearchOpen(false)} aria-label="Close search"><X size={16}/></button></div>}
      <div className="page-content"><section className="page-heading"><div><div className="eyebrow">— &nbsp; {today.toUpperCase()}</div><h1>{view === 'Overview' && data ? `Welcome, ${title}` : view === 'Overview' ? 'Academic workspace' : view}<i>.</i></h1><p>{data ? 'Your academic activity, records, and updates.' : 'Connected academic information, in one place.'}</p></div><button className="outline-button" onClick={() => setView('Timetable')}><CalendarDays size={15}/>View timetable</button></section>
        {view === 'Overview' && (data ? <Overview data={data} changeView={setView}/> : <EmptyState connection={connection} loadState={loadState} usn={usn} setUsn={setUsn} onSubmit={loadStudent}/>) }
        {view === 'My courses' && (data ? <CourseView courses={data.courses} semester={data.student.semester}/> : <EmptyState connection={connection} loadState={loadState} usn={usn} setUsn={setUsn} onSubmit={loadStudent}/>) }
        {view === 'Assignments' && data && <AssignmentView assignments={data.assignments}/>}
        {view === 'Learning materials' && data && <LearningMaterials materials={data.materials}/>}
        {view === 'Timetable' && (data ? <Timetable courses={data.courses}/> : <EmptyState connection={connection} loadState={loadState} usn={usn} setUsn={setUsn} onSubmit={loadStudent}/>) }
        {view === 'Records' && (studentUser && data ? <StudentRecords data={data}/> : <Records connection={connection}/>)}
        {view === 'Add student' && <StudentManager/>}
        {view === 'Import students' && staffUser?.role === 'admin' && <StudentRosterImporter connection={connection}/>}
        {view === 'Import data' && staffUser?.role === 'admin' && <CsvImportManager connection={connection}/>}
        {view === 'Assistant' && (studentUser || staffUser) && <AcademicAssistant connection={connection}/>}
        <footer className="page-footer"><span><i className={`status-indicator ${connection}`}/>{connection === 'connected' ? data ? 'Synced with campus database' : 'Connected · no student record loaded' : connection === 'checking' ? 'Checking database connection' : 'Database is unavailable'}</span><span>Updated from the academic database · <button onClick={() => setView('Records')}>Data &amp; privacy</button></span></footer>
      </div>
    </main>
  </div>
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function InstallButton() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt)
  }, [])

  async function install() {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  return installPrompt ? <button className="icon-button" onClick={() => void install()} aria-label="Install Student Lifecycle OS" title="Install app"><Download size={17}/></button> : null
}

type CsvImportEntity = { id: string; label: string; headers: string[] }
type AssistantMessage = { role: 'user' | 'model'; content: string }

function AcademicAssistant({ connection }: { connection: Connection }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = prompt.trim()
    if (!content || busy || connection !== 'connected') return
    const history = messages.slice(-18)
    const userMessage: AssistantMessage = { role: 'user', content }
    setMessages([...history, userMessage])
    setPrompt('')
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history, userMessage] }),
      })
      const result = await response.json() as { answer?: string; message?: string }
      if (!response.ok || !result.answer) throw new Error(result.message ?? 'The assistant could not respond.')
      setMessages([...history, userMessage, { role: 'model', content: result.answer }])
    } catch (sendError) {
      setMessages(history)
      setPrompt(content)
      setError(sendError instanceof Error ? sendError.message : 'Could not reach the assistant.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="assistant-panel panel">
    <div className="panel-heading"><div><small>ACADEMIC SUPPORT</small><h2>Gemini assistant</h2></div><span className="assistant-status"><i className="assistant-status-dot"/>Gemini</span></div>
    <div className="assistant-thread" aria-live="polite">
      {!messages.length && <div className="assistant-empty"><span><Sparkles size={18}/></span><h3>What can I help you with?</h3><p>Ask about study planning, coursework strategies, or academic concepts.</p></div>}
      {messages.map((message, index) => <article className={`assistant-message ${message.role === 'user' ? 'assistant-message-user' : 'assistant-message-model'}`} key={`${index}-${message.role}`}>
        <span className="assistant-message-icon">{message.role === 'user' ? <MessageCircle size={15}/> : <Sparkles size={15}/>}</span>
        <p>{message.content}</p>
      </article>)}
      {busy && <div className="assistant-thinking" role="status"><span/><span/><span/>Thinking</div>}
    </div>
    {error && <p className="auth-alert form-error assistant-error" role="alert">{error}</p>}
    <form className="assistant-composer" onSubmit={sendMessage}>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask an academic question…" aria-label="Message the Gemini assistant" maxLength={4000} rows={2} disabled={busy || connection !== 'connected'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>
      <button type="submit" aria-label="Send message" title="Send message" disabled={busy || connection !== 'connected' || !prompt.trim()}><Send size={17}/></button>
    </form>
    <p className="assistant-privacy">Your message goes to Google Gemini. Student database records are not sent.</p>
  </section>
}

function CsvImportManager({ connection }: { connection: Connection }) {
  const [entities, setEntities] = useState<CsvImportEntity[]>([])
  const [entityId, setEntityId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetch('/api/admin/csv-imports/entities')
      .then(async (response) => {
        const result = await response.json() as { entities?: CsvImportEntity[]; message?: string }
        if (!response.ok) throw new Error(result.message ?? 'Could not load import types.')
        const available = result.entities ?? []
        setEntities(available)
        setEntityId(available[0]?.id ?? '')
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load import types.'))
      .finally(() => setLoading(false))
  }, [])

  const selected = entities.find((entity) => entity.id === entityId)

  function downloadTemplate() {
    if (!selected) return
    const blob = new Blob([`${selected.headers.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${selected.id}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function importCsv(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || !file) return
    const form = event.currentTarget
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`/api/admin/csv-imports/${encodeURIComponent(selected.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      })
      const result = await response.json() as { imported?: number; message?: string }
      if (!response.ok) throw new Error(result.message ?? 'CSV import failed.')
      setMessage(result.message ?? `Imported ${result.imported ?? 0} records.`)
      setFile(null)
      form.reset()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'CSV import failed.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel csv-import-panel">
    <div className="panel-heading"><div><small>ACADEMIC DATA</small><h2>Import CSV records</h2></div><span className={`connection-pill ${connection}`}>{connection === 'connected' ? 'Database connected' : connection === 'checking' ? 'Checking database' : 'Database unavailable'}</span></div>
    <form className="csv-import-form" onSubmit={importCsv}>
      <label htmlFor="csv-entity">Record type</label>
      <select id="csv-entity" value={entityId} onChange={(event) => { setEntityId(event.target.value); setFile(null); setMessage(''); setError('') }} disabled={loading || busy || !entities.length}>
        {loading && <option value="">Loading record types…</option>}
        {!loading && entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.label}</option>)}
      </select>
      <button className="outline-button csv-template-button" type="button" onClick={downloadTemplate} disabled={!selected || busy}><Download size={15}/>Download CSV template</button>
      <label htmlFor="csv-file">CSV file</label>
      <input id="csv-file" type="file" accept=".csv,text/csv" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setMessage(''); setError('') }} disabled={busy}/>
      {error && <p className="auth-alert form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      <button className="auth-submit" type="submit" disabled={busy || connection !== 'connected' || !selected || !file}>{busy ? 'Importing…' : 'Upload and import'}<Upload size={16}/></button>
    </form>
  </section>
}

type StudentRosterImportResult = {
  students: number
  blankStudentNumbers: number
  blankStudentIds: number
  blankEmails: number
  already_imported?: boolean
  imported?: number
}

function StudentRosterImporter({ connection }: { connection: Connection }) {
  const [file, setFile] = useState<File | null>(null)
  const [validation, setValidation] = useState<StudentRosterImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function submitRoster(dryRun: boolean) {
    if (!file) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`/api/admin/student-roster/import${dryRun ? '?dryRun=true' : ''}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      })
      const result = await response.json() as StudentRosterImportResult & { validated?: boolean; message?: string }
      if (!response.ok) throw new Error(result.message ?? 'Student roster import failed.')
      if (result.already_imported) {
        setValidation(null)
        setMessage(`This workbook is already imported (${result.imported ?? result.students} student records). Nothing changed.`)
      } else if (dryRun) {
        setValidation(result)
      } else {
        setValidation(null)
        setMessage(`Imported ${result.imported ?? 0} students from ${file.name}.`)
        setFile(null)
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Student roster import failed.')
      if (dryRun) setValidation(null)
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel csv-import-panel">
    <div className="panel-heading"><div><small>STUDENT RECORDS</small><h2>Import student roster</h2></div><span className={`connection-pill ${connection}`}>{connection === 'connected' ? 'Database connected' : connection === 'checking' ? 'Checking database' : 'Database unavailable'}</span></div>
    <form className="csv-import-form roster-import-form" onSubmit={(event) => { event.preventDefault(); void submitRoster(true) }}>
      <label htmlFor="student-roster-file">Excel workbook (.xlsx)</label>
      <input id="student-roster-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setValidation(null); setMessage(''); setError('') }} disabled={busy}/>
      {validation && <div className="roster-import-summary" role="status"><strong>{validation.students} student rows validated</strong><span>{validation.blankStudentNumbers} blank student numbers · {validation.blankStudentIds} blank student IDs · {validation.blankEmails} blank emails</span><small>No records have been saved yet. Confirm the import to add this roster.</small></div>}
      {error && <p className="auth-alert form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      <div className="roster-import-actions">
        <button className="outline-button" type="submit" disabled={busy || connection !== 'connected' || !file}>{busy ? 'Validating…' : 'Validate workbook'}</button>
        {validation && <button className="auth-submit" type="button" onClick={() => void submitRoster(false)} disabled={busy || connection !== 'connected'}>{busy ? 'Importing…' : `Import ${validation.students} students`}<Upload size={16}/></button>}
      </div>
    </form>
  </section>
}

function AuthGate({ loading, connection, connectionMessage, error, busy, role, adminRegistrationOpen, registrationMessage, authenticatorQr, setRole, onSubmit, onRegister }: {
  loading: boolean
  connection: Connection
  connectionMessage: string
  error: string
  busy: boolean
  role: 'staff' | 'student'
  adminRegistrationOpen: boolean
  registrationMessage: string
  authenticatorQr: string | null
  setRole: (role: 'staff' | 'student') => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onRegister: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [registrationMode, setRegistrationMode] = useState(false)

  return <main className="auth-shell">
    <aside className="auth-rail">
      <a className="brand" href="#login"><span className="brand-mark"><GraduationCap size={20}/></span><span className="brand-name">Student Lifecycle OS</span></a>
      <div className="auth-rail-copy">
        <small>STUDENT PORTAL</small>
        <h1>{role === 'student' ? 'Academic life, in one place' : 'Student administration'}</h1>
        <p>{role === 'student' ? 'Track courses, assignments, schedules, and academic progress from a single secure dashboard.' : 'Manage enrollment, records, and student operations in one secure workspace.'}</p>
      </div>
      <button type="button" className="auth-support-button">Need help?</button>
      <div className="auth-footer-meta">
        <span>Built for student lifecycle management.</span>
      </div>
      <div className="auth-stats" aria-label="Platform highlights">
        <div><strong>Courses</strong><span>Learning</span></div>
        <div><strong>Schedule</strong><span>Planning</span></div>
        <div><strong>Progress</strong><span>Records</span></div>
        <div><strong>Support</strong><span>Guidance</span></div>
      </div>
      <div className="auth-rail-footer"><i className={`status-indicator ${connection}`}/>{connection === 'connected' ? 'PostgreSQL connected' : connection === 'checking' ? 'Checking database' : 'Database unavailable'}</div>
    </aside>
    <section className="auth-main">
      <div className="auth-form-wrap">
        <div className="auth-kicker">{role === 'student' ? 'STUDENT PORTAL' : 'ADMIN PORTAL'}</div>
        <h2>{loading ? 'Connecting…' : 'Welcome back'}</h2>
        <p className="auth-intro">{role === 'student' ? 'Use your USN, password, and authenticator code.' : 'Use your administrator email, password, and authenticator code.'}</p>
        <label htmlFor="account-type" className="auth-label">Account type</label>
        <select id="account-type" value={role} onChange={(event) => setRole(event.target.value as 'student' | 'staff')}>
          <option value="student">Student</option>
          <option value="staff">Admin</option>
        </select>
        {registrationMessage && <p className="auth-registration-notice" role="status">{registrationMessage}</p>}
        {connection === 'disconnected' && <p className="auth-alert" role="status">{connectionMessage}</p>}
        {error && <p className="auth-alert" role="alert">{error}</p>}
        {authenticatorQr && <div className="authenticator-setup"><p>Scan this QR code with an authenticator app configured for 60-second codes, then enter the current six-digit code below.</p><img src={authenticatorQr} alt="Authenticator enrollment QR code"/><small>Use a TOTP app that supports a 60-second period. Keep your authenticator private.</small></div>}
        {role === 'staff' && adminRegistrationOpen && <button className="auth-register-toggle" type="button" onClick={() => setRegistrationMode(!registrationMode)}>{registrationMode ? 'Back to sign in' : 'Set up first admin account'}</button>}
        {!loading && registrationMode && role === 'staff' && adminRegistrationOpen ? <form className="auth-form" onSubmit={onRegister}>
          <label htmlFor="admin-full-name">Full name</label>
          <input id="admin-full-name" name="full_name" type="text" autoComplete="name" maxLength={120} required/>
          <label htmlFor="admin-registration-email">Email</label>
          <input id="admin-registration-email" name="email" type="email" autoComplete="email" maxLength={254} required/>
          <label htmlFor="admin-registration-password">Password</label>
          <input id="admin-registration-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/>
          <label htmlFor="admin-bootstrap-code">Administrator bootstrap code</label>
          <input id="admin-bootstrap-code" name="signup_code" type="password" autoComplete="off" required/>
          <small className="auth-hint">Use the bootstrap code configured by the database owner. This is available only while no admin account exists.</small>
          <button className="auth-submit" type="submit" disabled={busy || connection !== 'connected'}>{busy ? 'Creating account…' : 'Create admin account'}<ChevronRight size={16}/></button>
        </form> : !loading && <form className="auth-form" onSubmit={onSubmit}>
          {role === 'student' ? <><label htmlFor="student-usn">USN (Student ID)</label><input id="student-usn" name="usn" type="text" autoCapitalize="characters" autoComplete="username" maxLength={40} required/></> : <><label htmlFor="staff-email">Email</label><input id="staff-email" name="email" type="email" autoComplete="username" maxLength={254} required/></>}
          <label htmlFor="staff-password">Password</label>
          <div className="auth-password-wrap">
            <input id="staff-password" name="password" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" minLength={1} maxLength={128} required/>
            <button type="button" className="auth-password-toggle" onClick={() => setPasswordVisible(!passwordVisible)} aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible} title={passwordVisible ? 'Hide password' : 'Show password'}>
              {passwordVisible ? <EyeOff size={16}/> : <Eye size={16}/>}
            </button>
          </div>
          <label htmlFor="authenticator-code">Authenticator code</label>
          <input id="authenticator-code" name="authenticator_code" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" aria-describedby="authenticator-hint"/>
          <small id="authenticator-hint" className="auth-hint">Use the current six-digit code. First sign-in starts authenticator setup.</small>
          <button className="auth-submit" type="submit" disabled={busy || connection !== 'connected'}>{busy ? 'Please wait…' : 'Sign in'}<ChevronRight size={16}/></button>
        </form>}
      </div>
    </section>
  </main>
}

function StudentManager() {
  const [students, setStudents] = useState<StudentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [accountStudentId, setAccountStudentId] = useState<number | null>(null)
  const [accountPassword, setAccountPassword] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  const [editingStudent, setEditingStudent] = useState<StudentRecord | null>(null)
  const [updating, setUpdating] = useState(false)
  const [editError, setEditError] = useState('')

  async function refreshStudents() {
    const response = await fetch('/api/students')
    const result = await response.json() as { students?: StudentRecord[]; message?: string }
    if (!response.ok) throw new Error(result.message ?? 'Could not load student records.')
    setStudents(result.students ?? [])
  }

  useEffect(() => {
    fetch('/api/students')
      .then(async (response) => {
        const result = await response.json() as { students?: StudentRecord[]; message?: string }
        if (!response.ok) throw new Error(result.message ?? 'Could not load student records.')
        setStudents(result.students ?? [])
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load student records.'))
      .finally(() => setLoading(false))
  }, [])

  async function addStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setSaving(true)
    setError('')
    setMessage('')
    const values = Object.fromEntries(new FormData(form).entries())
    try {
      const response = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const result = await response.json() as { student?: StudentRecord; account_created?: boolean; message?: string }
      if (!response.ok || !result.student) throw new Error(result.message ?? 'Could not save student record.')
      setMessage(result.account_created ? `Student record ${result.student.student_id} and login added.` : `Student record ${result.student.student_id} added.`)
      form.reset()
      await refreshStudents()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save student record.')
    } finally {
      setSaving(false)
    }
  }

  async function updateStudent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingStudent) return
    setUpdating(true)
    setEditError('')
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try {
      const response = await fetch(`/api/students/${editingStudent.student_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const result = await response.json() as { message?: string }
      if (!response.ok) throw new Error(result.message ?? 'Could not update the student record.')
      setMessage(`Student record ${editingStudent.student_id} updated.`)
      setEditingStudent(null)
      await refreshStudents()
    } catch (updateError) {
      setEditError(updateError instanceof Error ? updateError.message : 'Could not update the student record.')
    } finally {
      setUpdating(false)
    }
  }

  async function provisionStudent(event: React.FormEvent<HTMLFormElement>, studentId: number) {
    event.preventDefault()
    setProvisioning(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`/api/students/${studentId}/account`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: accountPassword }),
      })
      const result = await response.json() as { message?: string }
      if (!response.ok) throw new Error(result.message ?? 'Could not provision the student login.')
      setMessage(`Student login for record ${studentId} is ready. Share the password securely.`)
      setAccountPassword('')
      setAccountStudentId(null)
      await refreshStudents()
    } catch (provisionError) {
      setError(provisionError instanceof Error ? provisionError.message : 'Could not provision the student login.')
    } finally {
      setProvisioning(false)
    }
  }

  return <div className="student-manager">
    <section className="panel student-entry-panel">
      <div className="panel-heading"><div><small>STUDENT RECORD</small><h2>Add a student</h2></div></div>
      <form className="student-entry-form" onSubmit={addStudent}>
        <label>Application number<input name="roll_number" maxLength={24} autoComplete="off" required/></label>
        <label>USN (Student ID)<input name="institution_student_id" maxLength={40} autoComplete="off" required/></label>
        <label>First name<input name="first_name" maxLength={80} autoComplete="given-name" required/></label>
        <label>Last name<input name="last_name" maxLength={80} autoComplete="family-name" required/></label>
        <label>Email <span>Optional</span><input name="email" type="email" maxLength={254} autoComplete="email"/></label>
        <label>Admission date <span>Optional</span><input name="admission_date" type="date"/></label>
        <label>Program code <span>Optional</span><input name="program_code" maxLength={16} autoComplete="off"/></label>
        <label>Current semester<input name="current_semester" type="number" min="1" max="32767" defaultValue="1" required/></label>
        <label>Student login password <span>Optional, 12+ characters</span><input name="account_password" type="password" minLength={12} maxLength={128} autoComplete="new-password"/></label>
        {error && <p className="auth-alert form-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save student'}<ChevronRight size={16}/></button>
      </form>
    </section>
    <section className="panel student-list-panel">
      <div className="panel-heading"><div><small>DATABASE</small><h2>Recent students</h2></div><span className="quiet">Latest 100</span></div>
      {editingStudent && <form className="student-entry-form student-edit-form" onSubmit={updateStudent}>
        <h3>Edit student record {editingStudent.student_id}</h3>
        <label>Application number<input name="roll_number" defaultValue={editingStudent.roll_number ?? ''} maxLength={24} required/></label>
        <label>USN (Student ID)<input name="institution_student_id" defaultValue={editingStudent.institution_student_id ?? ''} maxLength={40} required/></label>
        <label>First name<input name="first_name" defaultValue={editingStudent.first_name} maxLength={80} required/></label>
        <label>Last name<input name="last_name" defaultValue={editingStudent.last_name} maxLength={80} required/></label>
        <label>Email<input name="email" type="email" defaultValue={editingStudent.email ?? ''} maxLength={254}/></label>
        <label>Admission date<input name="admission_date" type="date" defaultValue={editingStudent.admission_date ?? ''}/></label>
        <label>Program code<input name="program_code" defaultValue={editingStudent.program_code ?? ''} maxLength={16}/></label>
        <label>Current semester<input name="current_semester" type="number" min="1" max="32767" defaultValue={editingStudent.current_semester} required/></label>
        {editError && <p className="auth-alert form-error">{editError}</p>}
        <div className="student-edit-actions"><button className="auth-submit" type="submit" disabled={updating}>{updating ? 'Saving…' : 'Save changes'}<ChevronRight size={16}/></button><button className="text-button" type="button" onClick={() => { setEditingStudent(null); setEditError('') }}>Cancel</button></div>
      </form>}
      {message && <p className="form-success" role="status">{message}</p>}
      <div className="table-wrap student-table-wrap"><table className="courses-table student-table"><thead><tr><th>STUDENT</th><th>APPLICATION NO.</th><th>USN</th><th>EMAIL</th><th>SEMESTER</th><th>RECORD</th><th>LOGIN</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={7} className="table-empty">Loading student records…</td></tr>
          : students.length ? students.map((student) => <tr key={student.student_id}><td><b>{student.first_name} {student.last_name}</b></td><td>{student.roll_number || '—'}</td><td>{student.institution_student_id || '—'}</td><td>{student.email || '—'}</td><td>{student.current_semester}</td><td><button className="text-button" type="button" onClick={() => { setEditingStudent(student); setEditError('') }}>Edit</button></td><td>{accountStudentId === student.student_id ? <form className="student-account-form" onSubmit={(event) => provisionStudent(event, student.student_id)}><input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" aria-label="Student login password" placeholder="12+ characters" required/><button type="submit" disabled={provisioning}>{provisioning ? 'Saving…' : 'Save'}</button></form> : <button className="text-button" type="button" disabled={!student.institution_student_id} onClick={() => setAccountStudentId(student.student_id)}>{student.has_account ? 'Reset login' : 'Set up login'}</button>}</td></tr>)
            : <tr><td colSpan={7} className="table-empty">No student records.</td></tr>}
      </tbody></table></div>
    </section>
  </div>
}

function EmptyState({ connection, loadState, usn, setUsn, onSubmit }: { connection: Connection; loadState: string; usn: string; setUsn: (value: string) => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const message = loadState === 'not-found'
    ? 'No student record matches that USN.'
    : loadState === 'error' || connection === 'disconnected'
      ? 'The academic database could not be reached.'
        : 'Enter a student USN to load academic records from the database.'
      return <section className="panel empty-state"><span className="empty-icon"><Database size={20}/></span><small>DATABASE RECORD</small><h2>No academic data loaded</h2><p>{message}</p><form onSubmit={onSubmit}><label htmlFor="student-usn-lookup">USN (Student ID)</label><div><input id="student-usn-lookup" value={usn} onChange={(event) => setUsn(event.target.value)} autoCapitalize="characters" autoComplete="off"/><button className="outline-button" type="submit" disabled={loadState === 'loading' || !usn.trim()}>{loadState === 'loading' ? 'Loading…' : 'Load record'}<ChevronRight size={15}/></button></div></form></section>
}

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) { return <article className="metric-card"><div className="metric-top"><span className={`metric-icon ${tone}`}>{icon}</span></div><small>{label}</small><strong>{value}</strong><p>{detail}</p></article> }

function Overview({ data, changeView }: { data: Dashboard; changeView: (view: View) => void }) {
  const rows = data.courses.map((course) => ({ course }))
  return <><section className="metrics-grid"><Metric icon={<Activity size={17}/>} label="ATTENDANCE" value={`${data.attendance}%`} detail="Across enrolled courses" tone="green"/><Metric icon={<GraduationCap size={18}/>} label="TERM GPA" value={data.gpa.toFixed(2)} detail="Current academic term" tone="blue"/><Metric icon={<BookOpen size={17}/>} label="CREDITS" value={String(data.credits)} detail="Credits currently enrolled" tone="orange"/><Metric icon={<FileText size={17}/>} label="UPCOMING WORK" value={String(data.assignments.length)} detail="Assignments in your courses" tone="coral"/></section>
  <section className="dashboard-grid"><div className="content-column"><section className="panel"><div className="panel-heading"><div><small>ON YOUR CALENDAR</small><h2>Timetable</h2></div><button className="text-button" onClick={() => changeView('Timetable')}>Full timetable <ChevronRight size={15}/></button></div><div className="schedule-list">{rows.length ? rows.map(({ course }) => <div className="schedule-row" key={course.code}><span className="schedule-time"><b>{course.time}</b></span><span className={`schedule-marker ${course.color}`}><i/></span><span className="schedule-info"><b>{course.name}</b><small>{course.code} · {course.days} · {course.faculty}</small></span><span className="schedule-room"><small>ROOM</small><b>{course.room}</b></span></div>) : <p className="panel-empty">No timetable entries are available.</p>}</div></section>
  <section className="panel"><div className="panel-heading"><div><small>{data.student.semester.toUpperCase()}</small><h2>Your courses</h2></div><MoreHorizontal size={18}/></div><div className="table-wrap"><table className="courses-table"><thead><tr><th>COURSE</th><th>FACULTY</th><th>ATTENDANCE</th><th>GRADE</th></tr></thead><tbody>{data.courses.length ? data.courses.map(course => <tr key={course.code}><td><span className="course-cell"><i className={`course-dot ${course.color}`}/><span><b>{course.name}</b><small>{course.code} · {course.days}</small></span></span></td><td>{course.faculty}</td><td><span className="attendance-cell"><i><b style={{width:`${course.attendance}%`}}/></i>{course.attendance}%</span></td><td><strong className="grade">{course.grade || '—'}</strong></td></tr>) : <tr><td colSpan={4} className="table-empty">No enrolled courses.</td></tr>}</tbody></table></div><button className="panel-bottom-link" onClick={() => changeView('My courses')}>View all enrolled courses <ChevronRight size={15}/></button></section>
  <section className="panel"><div className="panel-heading"><div><small>FROM YOUR CAMPUS</small><h2>Announcements</h2></div></div><div className="announcement-list">{data.announcements.length ? data.announcements.map(item => <article className="announcement" key={item.title}><span className={`announcement-mark ${item.color}`}><Bell size={15}/></span><div><div className="announcement-meta"><b>{item.category}</b><time>{item.date}</time></div><h3>{item.title}</h3><p>{item.body}</p></div><ChevronRight size={15}/></article>) : <p className="panel-empty">No announcements are available.</p>}</div></section></div>
  <aside className="right-column"><section className="panel"><div className="panel-heading"><div><small>COURSEWORK</small><h2>Upcoming work</h2></div></div><div className="assignment-list">{data.assignments.length ? data.assignments.map((item,i) => <article className="assignment" key={`${item.course}-${item.title}`}><span className={`assignment-index n${i % 3}`}>{String(i + 1).padStart(2,'0')}</span><div><small>{item.course}</small><h3>{item.title}</h3><span className="due"><Clock3 size={13}/>Due {item.due}</span></div></article>) : <p className="panel-empty">No upcoming assignments.</p>}</div></section>
  <section className="attendance-feature"><div className="feature-heading"><span><Activity size={17}/></span>ATTENDANCE</div><strong>{data.attendance}<small>%</small></strong><p>Attendance recorded across your enrolled courses.</p><div className="meter"><i style={{width:`${data.attendance}%`}}/></div><div className="meter-labels"><span>0%</span><span>100%</span></div><button onClick={() => changeView('Records')}>View academic records <ChevronRight size={14}/></button></section>
  <section className="help-strip"><CircleHelp size={17}/><span><b>Need a hand?</b><small>Student services are here for you.</small></span><ChevronRight size={15}/></section></aside></section></>
}

function CourseView({ courses, semester }: { courses: Course[]; semester: string }) { return <section className="panel full-panel"><div className="panel-heading"><div><small>{semester.toUpperCase()}</small><h2>Enrolled courses</h2></div><span className="quiet">{courses.length} active sections</span></div>{courses.length ? <div className="course-grid">{courses.map(course => <article className="course-card" key={course.code}><i className={`course-band ${course.color}`}/><div><small>{course.code}</small><h3>{course.name}</h3><p>{course.faculty}</p><span><CalendarDays size={14}/>{course.days}</span><span><Clock3 size={14}/>{course.time}</span><footer>{course.attendance}% attendance<strong>{course.grade || '—'}</strong></footer></div></article>)}</div> : <p className="panel-empty">No courses are enrolled for this term.</p>}</section> }

function LearningMaterials({ materials }: { materials: Dashboard['materials'] }) {
  return <section className="panel full-panel">
    <div className="panel-heading"><div><small>COURSE LIBRARY</small><h2>Learning materials</h2></div><span className="quiet">{materials.length} resources</span></div>
    <div className="assignment-list">{materials.length ? materials.map((material) => {
      const url = safeResourceUrl(material.url)
      return <article className="assignment material-item" key={`${material.course}-${material.title}-${material.date}`}>
        <span className="assignment-index n1"><FileText size={16}/></span>
        <div><small>{material.course} · {material.type}</small><h3>{material.title}</h3><span className="due">Published {material.date}</span></div>
        {url && <a className="text-button" href={url} target="_blank" rel="noreferrer">Open resource <ChevronRight size={15}/></a>}
      </article>
    }) : <p className="panel-empty">No learning materials have been published for your courses.</p>}</div>
  </section>
}

function AssignmentView({ assignments }: { assignments: Dashboard['assignments'] }) {
  return <section className="panel full-panel">
    <div className="panel-heading"><div><small>COURSEWORK</small><h2>Assignments</h2></div><span className="quiet">{assignments.length} upcoming</span></div>
    <div className="assignment-list">{assignments.length ? assignments.map((item, index) => <article className="assignment" key={`${item.course}-${item.title}`}>
      <span className={`assignment-index n${index % 3}`}>{String(index + 1).padStart(2, '0')}</span>
      <div><small>{item.course}</small><h3>{item.title}</h3><span className="due"><Clock3 size={13}/>Due {item.due}</span></div>
      <strong className="grade">{item.status}</strong>
    </article>) : <p className="panel-empty">No upcoming assignments.</p>}</div>
  </section>
}

function safeResourceUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function Timetable({ courses }: { courses: Course[] }) {
  const times = [...new Set(courses.flatMap((course) => course.meetings.map((meeting) => meeting.startsAt)))].sort()
  return <section className="panel full-panel"><div className="panel-heading"><div><small>WEEKLY SCHEDULE</small><h2>This week</h2></div></div><div className="table-wrap"><table className="timetable"><thead><tr><th>TIME</th>{weekdays.map(day=><th key={day}>{day.slice(0,3).toUpperCase()}</th>)}</tr></thead><tbody>{times.length ? times.map(time=><tr key={time}><th>{time}</th>{weekdays.map((day, index)=>{const meetings=courses.flatMap(course=>course.meetings.filter(meeting=>meeting.day===index+1&&meeting.startsAt===time).map(meeting=>({course,meeting})));return <td key={day}>{meetings.map(({course,meeting})=><div className={`timetable-event ${course.color}`} key={`${course.code}-${meeting.endsAt}`}><b>{course.code}</b><span>{course.name}</span><small>{meeting.endsAt} · {course.room}</small></div>)}</td>})}</tr>) : <tr><td className="table-empty" colSpan={6}>No timetable entries are available.</td></tr>}</tbody></table></div></section>
}

function StudentRecords({ data }: { data: Dashboard }) {
  return <section className="panel full-panel"><div className="panel-heading"><div><small>ACADEMIC PROGRESS</small><h2>Your records</h2></div><span className="quiet">{data.student.semester}</span></div>
    <section className="metrics-grid"><Metric icon={<Activity size={17}/>} label="ATTENDANCE" value={`${data.attendance}%`} detail="Across enrolled courses" tone="green"/><Metric icon={<GraduationCap size={18}/>} label="TERM GPA" value={data.gpa.toFixed(2)} detail="Current academic term" tone="blue"/><Metric icon={<BookOpen size={17}/>} label="CREDITS" value={String(data.credits)} detail="Credits enrolled" tone="orange"/></section>
    <div className="table-wrap"><table className="courses-table"><thead><tr><th>COURSE</th><th>ATTENDANCE</th><th>GRADE</th></tr></thead><tbody>{data.courses.length ? data.courses.map(course=><tr key={course.code}><td><b>{course.name}</b><small>{course.code}</small></td><td>{course.attendance}%</td><td><strong className="grade">{course.grade || 'In progress'}</strong></td></tr>) : <tr><td colSpan={3} className="table-empty">No academic results are available.</td></tr>}</tbody></table></div>
  </section>
}

function Records({ connection }: { connection: Connection }) {
  const tables = [
    { name: 'students', relations: 'programs · enrollments · records', icon: Users },
    { name: 'faculty', relations: 'departments · sections', icon: GraduationCap },
    { name: 'courses', relations: 'departments · prerequisites', icon: BookOpen },
    { name: 'course_sections', relations: 'courses · faculty · terms', icon: CalendarDays },
    { name: 'enrollments', relations: 'students · sections · grades', icon: FileText },
    { name: 'attendance', relations: 'enrollments · class sessions', icon: Activity },
  ]
  return <div className="records-layout"><section className="panel full-panel"><div className="panel-heading"><div><small>RELATIONAL DATABASE</small><h2>Academic data model</h2></div><span className="connection-pill">{connection === 'connected' ? 'Live connection' : connection === 'checking' ? 'Checking connection' : 'Unavailable'}</span></div><p className="records-intro">A normalized source of truth for the student journey, from program enrollment through attendance, assessment, and academic history.</p>{tables.map(({ name, relations, icon: Icon }) => <article className="entity-row" key={name}><span><Icon size={17}/></span><b>{name}<small>Connected to {relations}</small></b><ChevronRight size={15}/></article>)}<div className="normalization-note"><Database size={17}/><p><b>Designed for data integrity</b><br/>Foreign keys preserve referential integrity; unique constraints prevent duplicate enrollments; views provide summaries without duplicating source records.</p></div></section><aside className="panel schema-panel"><small>LIFECYCLE FLOW</small><h2>From admission to outcomes</h2>{['Department','Program','Student','Enrollment','Course section','Academic activity','Student record'].map((name,i)=><div className="schema-node" key={name}><i>{String(i+1).padStart(2,'0')}</i><b>{name}</b></div>)}<footer><Database size={15}/>PostgreSQL · 3NF relational design</footer></aside></div>
}