import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";

export default function PrivacyScreen() {
  return <ScrollView contentContainerStyle={styles.content}>
    <Link href="/" style={styles.back}>رجوع</Link>
    <Text style={styles.title}>سياسة الخصوصية</Text>
    <Text style={styles.date}>آخر تحديث: 7 نوفمبر 2026</Text>
    <Section title="ما البيانات التي نستخدمها؟">يستخدم محرابي موقعك فقط لعرض الأماكن القريبة وحساب اتجاه القبلة ومواقيت الصلاة. لا يتم حفظ إحداثيات موقعك في قاعدة البيانات.</Section>
    <Section title="الحساب والمساهمات">عند إنشاء حساب نحتفظ بالاسم والبريد الإلكتروني وبيانات الأماكن والتقييمات التي ترسلها. نستخدم ذلك لتأمين الحساب وإدارة المحتوى.</Section>
    <Section title="الإشعارات">تذكيرات الصلاة اختيارية ومحلية على جهازك. لا تُرسل إجاباتك أو تفضيلاتك إلى الخادم.</Section>
    <Section title="الإعلانات وGoogle AdMob">قد يعرض محرابي إعلانات بدء من Google AdMob. عند تفعيلها، قد يعالج Google معلومات تقنية عن الجهاز ومعرّف الإعلان وبيانات التفاعل اللازمة لطلب الإعلانات وعرضها وقياسها، وفق إعدادات الموافقة والمتطلبات المحلية. عندما تتطلب منطقتك ذلك، يعرض التطبيق نموذج موافقة Google UMP قبل طلب الإعلان، ويمكنك تغيير الخيارات من «إعدادات خصوصية الإعلانات» في الحساب عندما يظهر الخيار. لمعرفة المزيد عن معالجة Google للبيانات، <Text style={styles.googleLink} onPress={() => void Linking.openURL("https://policies.google.com/privacy").catch(() => undefined)}>راجع سياسة خصوصية Google</Text>.</Section>
    <Section title="المشاركة">لا نبيع بياناتك. قد نشارك بيانات المكان العامة التي أرسلتها بعد مراجعتها، كما يرسل التطبيق إلى Google طلبات الإعلان اللازمة لتشغيل هذه الميزة وقياسها.</Section>
    <Section title="التواصل">للاستفسارات المتعلقة بالخصوصية، تواصل مع مالك التطبيق عبر قنوات الدعم المرتبطة بالمشروع.</Section>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}><Text style={styles.heading}>{title}</Text><Text style={styles.body}>{children}</Text></View>;
}

const styles = StyleSheet.create({ content: { padding: 22, paddingTop: 60, backgroundColor: "#F7F9FA", minHeight: "100%" }, back: { color: "#5AAFA7", textAlign: "right", fontWeight: "800", marginBottom: 18 }, title: { color: "#102D4A", fontSize: 28, fontWeight: "900", textAlign: "right" }, date: { color: "#788595", textAlign: "right", marginTop: 5, marginBottom: 22 }, section: { backgroundColor: "#FFF", borderRadius: 14, padding: 16, marginBottom: 12 }, heading: { color: "#102D4A", fontSize: 16, fontWeight: "900", textAlign: "right", marginBottom: 7 }, body: { color: "#122033", fontSize: 13, lineHeight: 23, textAlign: "right" }, googleLink: { color: "#2B6570", textDecorationLine: "underline", fontWeight: "700" } });
