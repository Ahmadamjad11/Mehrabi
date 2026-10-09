import { Link } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function TermsScreen() {
  return <ScrollView contentContainerStyle={styles.content}>
    <Link href="/" style={styles.back}>رجوع</Link>
    <Text style={styles.title}>شروط الاستخدام</Text>
    <Text style={styles.date}>آخر تحديث: أكتوبر 2026</Text>
    <Section title="الاستخدام المسؤول">استخدم مصلاي للعثور على أماكن الصلاة والمعلومات المساعدة. تأكد من البيانات قبل الاعتماد عليها، فقد تتغير ساعات العمل أو حالة المكان.</Section>
    <Section title="المساهمات">يجب أن تكون المعلومات التي تضيفها صحيحة ومفيدة. تخضع الأماكن الجديدة للمراجعة وقد يتم تعديلها أو رفضها أو حذفها إذا كانت مكررة أو غير دقيقة.</Section>
    <Section title="مواقيت الصلاة والقبلة">المواقيت محسوبة وفق طريقة حساب فلكية وموقع الجهاز، وقد تختلف دقائق قليلة عن تقويم المسجد المحلي. اسأل المسجد المحلي عند الحاجة.</Section>
    <Section title="الخدمة">نوفر التطبيق كما هو ونسعى للحفاظ على دقته واستمراريته، دون ضمان أن كل مكان أو معلومة متاح دائمًا.</Section>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: string }) {
  return <View style={styles.section}><Text style={styles.heading}>{title}</Text><Text style={styles.body}>{children}</Text></View>;
}

const styles = StyleSheet.create({ content: { padding: 22, paddingTop: 60, backgroundColor: "#F7F9FA", minHeight: "100%" }, back: { color: "#5AAFA7", textAlign: "right", fontWeight: "800", marginBottom: 18 }, title: { color: "#102D4A", fontSize: 28, fontWeight: "900", textAlign: "right" }, date: { color: "#788595", textAlign: "right", marginTop: 5, marginBottom: 22 }, section: { backgroundColor: "#FFF", borderRadius: 14, padding: 16, marginBottom: 12 }, heading: { color: "#102D4A", fontSize: 16, fontWeight: "900", textAlign: "right", marginBottom: 7 }, body: { color: "#122033", fontSize: 13, lineHeight: 23, textAlign: "right" } });
