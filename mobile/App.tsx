import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import * as SecureStore from 'expo-secure-store'

const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const sessionKey = 'student_lifecycle_session'

type Course = { code: string; name: string; faculty: string; attendance: number; grade: string | null }
type Dashboard = {
  student: { name: string; usn: string; program: string; semester: string }
  attendance: number
  gpa: number
  credits: number
  courses: Course[]
  assignments: { title: string; course: string; due: string; status: string }[]
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [usn, setUsn] = useState('')
  const [password, setPassword] = useState('')
  const [authenticatorCode, setAuthenticatorCode] = useState('')
  const [setupQr, setSetupQr] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    void SecureStore.getItemAsync(sessionKey).then(async (storedToken) => {
      if (!storedToken) return
      const response = await fetch(`${apiUrl}/api/student/dashboard`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      })
      if (!active) return
      if (response.ok) {
        setSessionToken(storedToken)
        setDashboard(await response.json() as Dashboard)
      } else {
        await SecureStore.deleteItemAsync(sessionKey)
      }
    }).catch(() => {
      if (active) setError('Cannot reach the academic service. Check the API address and connection.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  async function signIn() {
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(`${apiUrl}/api/student/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usn: usn.trim().toUpperCase(),
          password,
          authenticator_code: authenticatorCode,
          client: 'native',
        }),
      })
      const result = await response.json() as {
        message?: string
        authenticator_setup_required?: boolean
        qr_code?: string
        session_token?: string
      }
      if (!response.ok) throw new Error(result.message ?? 'Sign-in failed.')
      if (result.authenticator_setup_required && result.qr_code) {
        setSetupQr(result.qr_code)
        setError('')
        return
      }
      if (!result.session_token) throw new Error('The server did not return a student session.')
      const dashboardResponse = await fetch(`${apiUrl}/api/student/dashboard`, {
        headers: { Authorization: `Bearer ${result.session_token}` },
      })
      const studentDashboard = await dashboardResponse.json() as Dashboard | { message?: string }
      if (!dashboardResponse.ok) throw new Error('message' in studentDashboard ? studentDashboard.message ?? 'Could not load your workspace.' : 'Could not load your workspace.')
      await SecureStore.setItemAsync(sessionKey, result.session_token)
      setSessionToken(result.session_token)
      setDashboard(studentDashboard as Dashboard)
      setSetupQr('')
      setPassword('')
      setAuthenticatorCode('')
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Could not sign in.')
    } finally {
      setSubmitting(false)
    }
  }

  async function signOut() {
    if (sessionToken) {
      await fetch(`${apiUrl}/api/student/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).catch(() => undefined)
    }
    await SecureStore.deleteItemAsync(sessionKey)
    setSessionToken(null)
    setDashboard(null)
  }

  if (loading) return <SafeAreaView style={styles.center}><ActivityIndicator color="#28624f"/></SafeAreaView>

  if (dashboard) return <SafeAreaView style={styles.screen}>
    <StatusBar barStyle="dark-content"/>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>STUDENT LIFECYCLE OS</Text>
      <View style={styles.header}>
        <View><Text style={styles.title}>Welcome, {dashboard.student.name}</Text><Text style={styles.subtle}>{dashboard.student.usn} · {dashboard.student.semester}</Text></View>
        <TouchableOpacity accessibilityRole="button" onPress={() => void signOut()}><Text style={styles.signOut}>Sign out</Text></TouchableOpacity>
      </View>
      <View style={styles.metrics}>
        <Metric label="ATTENDANCE" value={`${dashboard.attendance}%`}/>
        <Metric label="TERM GPA" value={dashboard.gpa.toFixed(2)}/>
        <Metric label="CREDITS" value={String(dashboard.credits)}/>
      </View>
      <Text style={styles.sectionTitle}>My courses</Text>
      {dashboard.courses.map((course) => <View key={course.code} style={styles.row}>
        <Text style={styles.courseCode}>{course.code}</Text>
        <Text style={styles.courseName}>{course.name}</Text>
        <Text style={styles.subtle}>{course.faculty} · {course.attendance}% attendance · {course.grade ?? 'In progress'}</Text>
      </View>)}
      <Text style={styles.sectionTitle}>Upcoming assignments</Text>
      {dashboard.assignments.map((assignment) => <View key={`${assignment.course}-${assignment.title}`} style={styles.row}>
        <Text style={styles.courseName}>{assignment.title}</Text>
        <Text style={styles.subtle}>{assignment.course} · Due {assignment.due}</Text>
        <Text style={styles.badge}>{assignment.status}</Text>
      </View>)}
    </ScrollView>
  </SafeAreaView>

  return <SafeAreaView style={styles.screen}>
    <StatusBar barStyle="dark-content"/>
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.kicker}>STUDENT LIFECYCLE OS</Text>
        <Text style={styles.title}>Student sign in</Text>
        <Text style={styles.subtle}>Use your USN, password, and current authenticator code.</Text>
        {setupQr ? <View style={styles.qrPanel}>
          <Text style={styles.courseName}>Set up your authenticator</Text>
          <Text style={styles.subtle}>Scan with a TOTP app that supports 60-second codes, then enter its current code below.</Text>
          <Image source={{ uri: setupQr }} style={styles.qrImage} accessibilityLabel="Authenticator setup QR code"/>
        </View> : null}
        <TextInput style={styles.input} placeholder="USN" autoCapitalize="characters" autoComplete="username" value={usn} onChangeText={setUsn}/>
        <TextInput style={styles.input} placeholder="Password" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword}/>
        <TextInput style={styles.input} placeholder="Six-digit authenticator code" keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" value={authenticatorCode} onChangeText={setAuthenticatorCode}/>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.button, submitting && styles.disabled]} onPress={() => void signIn()} disabled={submitting} accessibilityRole="button">
          <Text style={styles.buttonText}>{submitting ? 'Signing in…' : 'Sign in'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f7f4' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f6f7f4' },
  keyboard: { flex: 1 },
  content: { padding: 22, paddingBottom: 48, gap: 14 },
  authContent: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  kicker: { color: '#527064', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  title: { color: '#173b34', fontSize: 26, fontWeight: '700' },
  subtle: { color: '#64766d', fontSize: 13, lineHeight: 20 },
  signOut: { color: '#28624f', fontWeight: '700' },
  metrics: { flexDirection: 'row', gap: 9 },
  metric: { flex: 1, minHeight: 88, justifyContent: 'center', gap: 8, padding: 13, borderRadius: 8, backgroundColor: '#e7efe8' },
  metricLabel: { color: '#587064', fontSize: 9, fontWeight: '700' },
  metricValue: { color: '#173b34', fontSize: 23, fontWeight: '700' },
  sectionTitle: { marginTop: 14, color: '#173b34', fontSize: 18, fontWeight: '700' },
  row: { gap: 5, padding: 14, borderRadius: 8, backgroundColor: '#fff' },
  courseCode: { color: '#527064', fontSize: 11, fontWeight: '700' },
  courseName: { color: '#223d32', fontSize: 15, fontWeight: '700' },
  badge: { alignSelf: 'flex-start', color: '#28624f', fontSize: 11, fontWeight: '700' },
  input: { minHeight: 48, paddingHorizontal: 13, borderWidth: 1, borderColor: '#d5ded7', borderRadius: 6, backgroundColor: '#fff', color: '#19382e' },
  error: { color: '#a3423d', fontSize: 13, lineHeight: 19 },
  button: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: '#173b34' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  qrPanel: { alignItems: 'center', gap: 10, padding: 16, borderRadius: 8, backgroundColor: '#fff' },
  qrImage: { width: 220, height: 220, marginVertical: 4 },
})