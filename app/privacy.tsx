import { Link } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function PrivacyScreen() {
  return <ScrollView contentContainerStyle={styles.content}>
    <Link href="/" style={styles.back}>رجوع</Link>
    <Text style={styles.title}>سياسة الخصوصية</Text>
    <Text style={styles.date}>آخر تحديث: أكتوبر 2026</Text>
    <Section title="ما البيانات التي نستخدمها؟">يستخدم مصلاي موقعك فقط لعرض الأماكن القريبة وحساب اتجاه القبلة ومواقيت الصلاة. لا يتم حفظ إحداثيات موقعك في قاعدة البيانات.</Section>
    <Section title="الحساب والمساهمات">عند إنشاء حساب نحتفظ بالاسم والبريد الإلكتروني وبيانات الأماكن والتقييمات التي ترسلها. نستخدم ذلك لتأمين الحساب وإدارة المحتوى.</Section>
    <Section title="الإشعارات">تذكيرات الصلاة اختيارية ومحلية على جهازك. لا تُرسل إجاباتك أو تفضيلاتك إلى الخادم.</Section>
    <Section title="المشاركة">لا نبيع بياناتك ولا نستخدمها للإعلانات المخصصة. قد نشارك بيانات المكان العامة التي أرسلتها بعد مراجعتها.</Section>
    <Section title="التواصل">للاستفسارات المتعلقة بالخصوصية، تواصل مع مالك التطبيق عبر قنوات الدعم المرتبطة بالمشروع.</Section>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: string }) {
  return <View style={styles.section}><Text style={styles.heading}>{title}</Text><Text style={styles.body}>{children}</Text></View>;
}

const styles = StyleSheet.create({ content: { padding: 22, paddingTop: 60, backgroundColor: "#F7F9FA", minHeight: "100%" }, back: { color: "#5AAFA7", textAlign: "right", fontWeight: "800", marginBottom: 18 }, title: { color: "#102D4A", fontSize: 28, fontWeight: "900", textAlign: "right" }, date: { color: "#788595", textAlign: "right", marginTop: 5, marginBottom: 22 }, section: { backgroundColor: "#FFF", borderRadius: 14, padding: 16, marginBottom: 12 }, heading: { color: "#102D4A", fontSize: 16, fontWeight: "900", textAlign: "right", marginBottom: 7 }, body: { color: "#122033", fontSize: 13, lineHeight: 23, textAlign: "right" } });
