import { ref, onMounted } from 'vue'
import { supabase } from './supabase'

const LICENSE_STORAGE_KEY = 'iris_license_key'

export function useLicense() {
    const licenseKey = ref(localStorage.getItem(LICENSE_STORAGE_KEY) || '')
    const isValid = ref(false)
    const isChecking = ref(false)
    const error = ref<string | null>(null)
    const planType = ref<string | null>(null)

    const validateLicense = async (key: string) => {
        if (!key) {
            error.value = 'License key is required'
            return false
        }

        isChecking.value = true
        error.value = null

        try {
            const cleanKey = key.trim().toUpperCase()

            // Use an RPC function that runs with SECURITY DEFINER, bypassing RLS.
            // This is required because the anon role has no SELECT policy on the
            // licenses table.  Run the SQL in supabase-rpc-setup.sql to create it.
            const { data, error: rpcError } = await supabase
                .rpc('validate_license_key', { p_license_key: cleanKey })

            if (rpcError) {
                // If the RPC function doesn't exist yet, fall through to direct query
                if (rpcError.code === 'PGRST202' || rpcError.message?.includes('Could not find')) {
                    console.warn('validate_license_key RPC not found, falling back to direct query')
                    return await validateLicenseDirect(cleanKey)
                }
                throw rpcError
            }

            // RPC returns: { is_active: boolean, plan_type: string } or null
            if (!data || data.length === 0) {
                error.value = 'Invalid license key'
                isValid.value = false
                planType.value = null
                return false
            }

            const result = Array.isArray(data) ? data[0] : data

            if (!result.is_active) {
                error.value = 'License is inactive'
                isValid.value = false
                planType.value = null
                return false
            }

            licenseKey.value = cleanKey
            isValid.value = true
            planType.value = result.plan_type || 'Trial'
            localStorage.setItem(LICENSE_STORAGE_KEY, cleanKey)
            return true

        } catch (err: any) {
            console.error('License validation error:', err)
            error.value = err.message || 'Failed to validate license'
            isValid.value = false
            planType.value = null
            return false
        } finally {
            isChecking.value = false
        }
    }

    // Direct table query fallback (requires RLS SELECT policy to be configured)
    const validateLicenseDirect = async (cleanKey: string): Promise<boolean> => {
        const { data, error: sbError } = await supabase
            .from('licenses')
            .select(`
                is_active,
                customers (
                    subscriptions (
                        plan_type
                    )
                )
            `)
            .eq('license_key', cleanKey)
            .maybeSingle()

        if (sbError) throw sbError

        if (!data) {
            error.value = 'Invalid license key'
            isValid.value = false
            planType.value = null
            return false
        }

        if (!data.is_active) {
            error.value = 'License is inactive'
            isValid.value = false
            planType.value = null
            return false
        }

        licenseKey.value = cleanKey
        isValid.value = true
        const customer = data.customers as any
        const subscription = customer?.subscriptions?.[0]
        planType.value = subscription?.plan_type || 'Trial'
        localStorage.setItem(LICENSE_STORAGE_KEY, cleanKey)
        return true
    }

    const logout = () => {
        licenseKey.value = ''
        isValid.value = false
        planType.value = null
        localStorage.removeItem(LICENSE_STORAGE_KEY)
    }

    onMounted(async () => {
        if (licenseKey.value) {
            await validateLicense(licenseKey.value)
        }
    })

    return {
        licenseKey,
        isValid,
        isChecking,
        error,
        planType,
        validateLicense,
        logout
    }
}
