"""Recette admin réelle sur fixtures MongoDB jetables, sans fournisseur externe."""
import json, sys, re
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixtures = json.loads(Path(fixture_path).read_text())
out = Path(result_path).parent
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []
def checked(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

def gql(page, query, variables=None, token=None):
    return page.evaluate('''async ({query, variables, token}) => {
      const r = await fetch('/api/delifast/graphql', {method:'POST',
        headers:{'content-type':'application/json', ...(token?{authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({query,variables:variables||{}})}); return r.json();
    }''', dict(query=query, variables=variables, token=token))

def success(page, query, variables=None, token=None):
    result = gql(page, query, variables, token)
    assert not result.get('errors'), result.get('errors')
    return result['data']

def login(page):
    page.goto(base + '/delifast')
    page.get_by_label('Email', exact=True).fill('admin@delifast.local')
    page.get_by_label('Mot de passe', exact=True).fill('AdminDemo!2026')
    page.get_by_role('button', name='Se connecter', exact=True).click()
    expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()

def capture(page, name):
    page.screenshot(path=str(out / name), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run'])
    external, errors = [], []
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    def guard(route):
        url = route.request.url
        if urlsplit(url).scheme in ('data','blob') or url.startswith(base + '/'):
            route.continue_()
        else:
            external.append(url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    rider_reads, rider_details, all_queries = [], [], []
    def track_riders(route):
        body = json.loads(route.request.post_data or '{}')
        query = body.get('query', '')
        all_queries.append(query)
        if 'operationsRiderSummaries(' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            result = payload['data']['operationsRiderSummaries']
            assert len(result['items']) <= 20
            assert all(set(item) == {'id', 'name'} for item in result['items'])
            assert len(response.body()) < 10000
            rider_reads.append((body, result))
            route.fulfill(response=response)
        elif 'operationsRider(id:' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            result = payload['data']['operationsRider']
            assert result is None or set(result) == {'id', 'name', 'role', 'restaurantId'}
            rider_details.append((body, result))
            route.fulfill(response=response)
        else:
            route.fallback()
    page.route('**/api/delifast/graphql', track_riders)
    login(page)
    assert not rider_reads and not rider_details, 'Aucun catalogue livreur avant le besoin d’affectation'

    admin = page.evaluate("sessionStorage.getItem('delifast-local-session')")
    assert admin
    ids = fixtures['orders']
    paged = fixtures['paged']
    filters = page.locator('section[aria-label="Filtres commandes"]')
    search = page.get_by_role('searchbox', name='Rechercher une commande')
    apply = filters.get_by_role('button', name='Appliquer les filtres', exact=True)
    rows = page.locator('button[aria-label^="Ouvrir la commande "]')
    def apply_order_filters():
        with page.expect_response(lambda response: 'operationsOrdersPage(' in (response.request.post_data or '')):
            apply.click()
        expect(page.get_by_role('button', name='Actualiser', exact=True)).to_be_enabled()
    # Restaurant catalogue is an independent cursor: summaries are minimal and
    # bounded even though the old unpaged payload is deliberately >2 MiB.
    catalog = page.locator('section[aria-label="Catalogue restaurants paginé"]')
    restaurant_rows = catalog.locator('.df-restaurant-list > div')
    summary_requests = []
    def track_restaurant_summaries(route):
        body = json.loads(route.request.post_data or '{}')
        if 'operationsRestaurantSummaries(' in body.get('query', ''):
            summary_requests.append(body)
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload.get('errors')
            page_data = payload['data']['operationsRestaurantSummaries']
            assert len(page_data['items']) <= 20
            assert all(set(item) == {'id', 'name', 'open', 'version'} for item in page_data['items'])
            assert 'operationsRestaurants' not in body['query']
            assert all(field not in body['query'] for field in ('description', 'weeklySchedule', 'deliveryZoneIds'))
            route.fulfill(response=response)
        else:
            route.fallback()
    page.route('**/api/delifast/graphql', track_restaurant_summaries)
    expect(restaurant_rows).to_have_count(20)
    expect(catalog.get_by_text('Page 1', exact=False)).to_be_visible()
    first_restaurant_ids = set(catalog.locator('.df-restaurant-list small').all_inner_texts())
    with page.expect_response(lambda response: 'operationsRestaurantSummaries(' in (response.request.post_data or '')):
        catalog.get_by_role('button', name='Suivante', exact=True).click()
    expect(page.get_by_role('button', name='Actualiser', exact=True)).to_be_enabled()
    expect(catalog.get_by_text('Page 2', exact=False)).to_be_visible()
    expect(restaurant_rows).to_have_count(20)
    second_restaurant_ids = set(catalog.locator('.df-restaurant-list small').all_inner_texts())
    assert first_restaurant_ids.isdisjoint(second_restaurant_ids)
    for page_number in range(3, 8):
        with page.expect_response(lambda response: 'operationsRestaurantSummaries(' in (response.request.post_data or '')):
            catalog.get_by_role('button', name='Suivante', exact=True).click()
        expect(page.get_by_role('button', name='Actualiser', exact=True)).to_be_enabled()
        expect(catalog.get_by_text(f'Page {page_number}', exact=True)).to_be_visible()
    expect(catalog.get_by_text('Page 7', exact=False)).to_be_visible()
    expect(restaurant_rows).to_have_count(7)
    expect(catalog.get_by_text('ID z-fixture-124', exact=False)).to_be_visible()
    assert len(summary_requests) >= 6
    checked('catalogue restaurants indépendant paginé : première, deuxième et dernière page, 20 maximum sans doublon')
    # Exact ID reaches a restaurant outside the initial page; its rich profile is
    # fetched only after explicitly selecting the detail action.
    exact_id = catalog.get_by_label('ID catalogue exact', exact=True)
    previous_requests = len(summary_requests)
    exact_id.fill('z-fixture-124')
    assert len(summary_requests) == previous_requests, 'Le brouillon ne déclenche pas de requête'
    catalog.get_by_role('button', name='Appliquer ID restaurant', exact=True).click()
    expect(restaurant_rows).to_have_count(1)
    expect(catalog.get_by_text('ID z-fixture-124', exact=False)).to_be_visible()
    catalog.get_by_role('button', name='Charger le détail', exact=True).click()
    expect(catalog.get_by_text('Détail chargé :', exact=False)).to_be_visible()
    profiles = page.locator('section').filter(has=page.get_by_role('heading', name='Créer ou modifier un profil', exact=True))
    profiles.get_by_role('button', name='Modifier', exact=True).click()
    expect(profiles.locator('textarea')).to_have_value(re.compile('Description riche du profil z-fixture-124'))
    profiles.get_by_role('button', name='Annuler', exact=True).click()
    page.set_viewport_size({'width':390,'height':844})
    catalog.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    capture(page, 'admin-restaurants-390.png')
    page.set_viewport_size({'width':1280,'height':900})
    checked('ID restaurant exact hors page initiale et détail profil chargé à la demande')
    catalog.get_by_role('button', name='Effacer filtre restaurants', exact=True).click()
    expect(restaurant_rows).to_have_count(20)
    expect(catalog.get_by_text('Page 1', exact=False)).to_be_visible()
    assert len(summary_requests) >= 8
    page.unroute('**/api/delifast/graphql', track_restaurant_summaries)
    checked('reset filtres restaurant restauré en page 1 et borne 20')
    assert rows.count() <= 20
    first_page = set(rows.all_inner_texts())
    first_label = rows.first.get_attribute('aria-label')
    order_pagination = page.locator('[aria-label="Pagination"]')
    page_two = order_pagination.get_by_role('button', name='Suivante', exact=True)
    expect(page_two).to_be_enabled()
    page_two.click()
    expect(order_pagination.get_by_text('Page 2', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name=first_label, exact=True)).to_have_count(0)
    expect(rows).to_have_count(20)
    second_page = set(rows.all_inner_texts())
    assert first_page.isdisjoint(second_page), (first_page, second_page)
    order_pagination.get_by_role('button', name='Précédente', exact=True).click()
    expect(order_pagination.get_by_text('Page 1', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name=first_label, exact=True)).to_be_visible()
    checked('pages serveur bornées à 20 sans doublon entre pages')
    # The target is deliberately outside page 1; only an explicit Apply may issue
    # the server-side search request.
    search.fill(paged[0])
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_have_count(0)
    apply_order_filters()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_be_visible()
    filters.get_by_label('Paiement', exact=True).select_option('PAID')
    filters.get_by_label('Statut', exact=True).select_option('CONFIRMED')
    filters.get_by_label('ID restaurant exact', exact=True).fill('rest-koudougou')
    apply_order_filters()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_be_visible()
    page.get_by_role('button', name='Effacer les filtres', exact=True).click()
    filters.get_by_label('Statut', exact=True).select_option('CONFIRMED')
    apply_order_filters()
    checked('recherche serveur hors première page et filtres combinés appliqués explicitement')
    link = page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)
    expect(link).to_be_enabled()
    link.focus(); page.keyboard.press('Enter')
    detail = page.locator('aside[aria-label="Détail de la commande"]')
    expect(detail).to_be_visible()
    # The server accepts the write but its response is lost. No automatic replay.
    lost = {'count':0}
    def lose_order(route):
        if 'transitionOrder(' in (route.request.post_data or ''):
            lost['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_order)
    page.get_by_role('button', name='Passer à ACCEPTED', exact=True).click()
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_text('Résultat à vérifier.', exact=False)).to_be_visible()
    assert lost['count'] == 1
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)).to_have_count(0)
    expect(detail.get_by_role('button', name='Passer à PREPARING', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', lose_order)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(detail.get_by_text('ACCEPTED ·', exact=False)).to_be_visible()
    expect(detail.get_by_role('button', name='Passer à PREPARING', exact=True)).to_be_enabled()
    checked('mutation CONFIRMED acceptée réponse perdue : commande sortie de liste, détail indépendant relu et action réautorisée')
    # Rider catalogue is loaded only in an assignable order, independently of the
    # restaurant/order cursors. 125 rich fixtures plus the seed span seven pages.
    picker = detail.locator('.df-rider-picker')
    rider_select = picker.get_by_role('combobox', name='Livreur', exact=True)
    expect(rider_select).to_be_enabled()
    expect(rider_select.locator('option')).to_have_count(21)
    assert not rider_details, 'Les résumés ne déclenchent pas de détail automatique'
    def rider_ids():
        return rider_select.locator('option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)')
    seen_riders = set(rider_ids())
    assert len(seen_riders) == 20
    for number in range(2, 8):
        with page.expect_response(lambda response: 'operationsRiderSummaries(' in (response.request.post_data or '')):
            picker.get_by_role('button', name='Suivante', exact=True).click()
        expect(rider_select).to_be_enabled()
        expect(picker.get_by_text(f'Page {number} ·', exact=False)).to_be_visible()
        expect(rider_select.locator('option')).to_have_count(7 if number == 7 else 21)
        current = set(rider_ids())
        assert seen_riders.isdisjoint(current)
        seen_riders.update(current)
    assert len(seen_riders) == 126
    assert 'z-rider-inactive' not in seen_riders and 'z-rider-non-rider' not in seen_riders
    expect(picker.get_by_role('button', name='Suivante', exact=True)).to_be_disabled()
    expect(order_pagination.get_by_text('Page 1', exact=True)).to_be_visible()
    expect(catalog.get_by_text('Page 1', exact=True)).to_be_visible()
    checked('livreurs : 126 actifs sur sept pages indépendantes, 20 résumés minimaux maximum, sans doublon ni lecture de détail automatique')
    exact_rider = picker.get_by_label('ID livreur exact', exact=True)
    before = len(rider_reads)
    exact_rider.fill('z-rider-fixture-124')
    assert len(rider_reads) == before, 'Pas de recherche livreur à chaque frappe'
    picker.get_by_role('button', name='Rechercher', exact=True).click()
    expect(rider_select).to_be_enabled()
    expect(rider_select.locator('option')).to_have_count(2)
    assert rider_ids() == ['z-rider-fixture-124']
    assert rider_reads[-1][0]['variables']['riderId'] == 'z-rider-fixture-124'
    expect(detail.get_by_role('button', name='Affecter ce livreur', exact=True)).to_be_disabled()
    with page.expect_response(lambda response: 'operationsRider(id:' in (response.request.post_data or '')):
        rider_select.select_option('z-rider-fixture-124')
    rider_detail = picker.locator('[aria-label="Détail du livreur"]')
    expect(rider_detail).to_contain_text('ID z-rider-fixture-124 · RIDER')
    expect(detail.get_by_role('button', name='Affecter ce livreur', exact=True)).to_be_enabled()
    page.set_viewport_size({'width':390,'height':844})
    picker.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    capture(page, 'admin-riders-390.png')
    page.set_viewport_size({'width':1280,'height':900})
    # Clear must revoke the old verified selection; an inactive exact ID is empty.
    picker.get_by_role('button', name='Effacer', exact=True).click()
    expect(rider_select.locator('option')).to_have_count(21)
    expect(rider_detail).to_have_count(0)
    expect(detail.get_by_role('button', name='Affecter ce livreur', exact=True)).to_be_disabled()
    exact_rider.fill('z-rider-inactive')
    picker.get_by_role('button', name='Rechercher', exact=True).click()
    expect(rider_select).to_be_enabled()
    expect(rider_select.locator('option')).to_have_count(1)
    exact_rider.fill('z-rider-fixture-124')
    picker.get_by_role('button', name='Rechercher', exact=True).click()
    expect(rider_select.locator('option')).to_have_count(2)
    rider_select.select_option('z-rider-fixture-124')
    expect(rider_detail).to_contain_text('ID z-rider-fixture-124 · RIDER')
    detail.get_by_role('button', name='Affecter ce livreur', exact=True).click()
    expect(page.locator('.df-banner[role="status"]')).to_contain_text('Livreur affecté')
    assigned = success(page, 'query($id:ID!){operationsOrder(id:$id){id riderId status}}', {'id':ids[0]}, admin)['operationsOrder']
    assert assigned['riderId'] == 'z-rider-fixture-124' and assigned['status'] == 'ACCEPTED'
    capture(page, 'admin-rider-assigned.png')
    checked('livreur ID exact hors page 1, détail ciblé vérifié, reset/ID inactif et affectation synthétique via UI ; 390px sans débordement')
    # A second lost write leaves the detail blocked. A page refresh may succeed,
    # but a failed independent detail read must not clear that safety lock.
    lost_preparing = {'count': 0}
    def lose_preparing(route):
        if 'transitionOrder(' in (route.request.post_data or ''):
            lost_preparing['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_preparing)
    detail.get_by_role('button', name='Passer à PREPARING', exact=True).click()
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_text('Résultat à vérifier.', exact=False)).to_be_visible()
    assert lost_preparing['count'] == 1
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', lose_preparing)
    reload_fail = {'count': 0}
    def fail_detail_reload(route):
        if 'operationsOrder(id:' in (route.request.post_data or ''):
            reload_fail['count'] += 1
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', fail_detail_reload)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(page.locator('.df-banner[role="status"]')).to_contain_text(re.compile('Failed to fetch|Erreur de lecture du détail'))
    assert reload_fail['count'] == 1
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    # Exercise the 2,000,000-byte client guard on a read. The response is
    # deliberately not a success-shaped payload and no write is attempted.
    def oversized_detail(route):
        if 'operationsOrder(id:' in (route.request.post_data or ''):
            route.fulfill(status=200, headers={'content-type': 'application/json'}, body='x' * 2000001)
        else: route.fallback()
    page.route('**/api/delifast/graphql', oversized_detail)
    page.get_by_role('button', name='Actualiser', exact=True).click()
    expect(page.locator('.df-banner[role="status"]')).to_contain_text('Réponse API trop volumineuse')
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', fail_detail_reload)
    page.unroute('**/api/delifast/graphql', oversized_detail)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(detail.get_by_text('PREPARING ·', exact=False)).to_be_visible()
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_enabled()
    checked('échec de relecture détail et lecture API >2 Mo : verrouillage conservé malgré page chargée, puis reprise explicite sans faux succès ni écriture')
    page.get_by_role('button', name='Support', exact=True).click()
    support = page.locator('section[aria-label="Support"]')
    summary_requests, summary_responses = [], []
    def track_summary(route):
        if 'operationsSupportTicketSummaries(' in (route.request.post_data or ''):
            payload = json.loads(route.request.post_data)
            summary_requests.append(payload)
            response = route.fetch()
            data = response.json()
            assert not data.get('errors'), data.get('errors')
            summaries = data['data']['operationsSupportTicketSummaries']
            assert len(summaries) <= 20
            allowed = {'id', 'subject', 'creatorRole', 'status', 'version', 'createdAt', 'updatedAt'}
            assert all(set(row) == allowed for row in summaries), summaries
            summary_responses.append(summaries)
            route.fulfill(response=response)
        else:
            route.fallback()
    page.route('**/api/delifast/graphql', track_summary)
    def support_filter_action(name):
        with page.expect_response(lambda response: 'operationsSupportTicketSummaries(' in (response.request.post_data or '')):
            support.get_by_role('button', name=name, exact=True).click()
        expect(support.get_by_role('button', name='Relire la page', exact=True)).to_be_enabled()
    expect(support.get_by_role('button', name='Recette support 1', exact=True)).to_be_visible()
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(20)
    support_search = support.get_by_role('searchbox', name='Identifiant exact du ticket', exact=True)
    assert support_search.get_attribute('maxlength') == '128'
    support.get_by_role('button', name='Précédente', exact=True).click()
    expect(support.get_by_text('Page 1', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(20)
    before_search = len(summary_requests)
    support_search.fill('page-ticket-19')
    assert len(summary_requests) == before_search, 'Pas de requête à chaque frappe'
    expect(support.get_by_role('button', name='Recette support 22', exact=True)).to_have_count(0)
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(1)
    expect(support.get_by_role('button', name='Recette support 22', exact=True)).to_be_visible()
    assert summary_requests[-1]['variables']['ticketId'] == 'page-ticket-19'
    assert summary_requests[-1]['variables']['offset'] == 0
    capture(page, 'support-search-exact.png')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(1)
    assert all('description' not in x['query'] and 'history' not in x['query'] and 'creatorId' not in x['query'] for x in summary_requests)
    support_search.fill('inconnu-synthetique')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(0)
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    expect(support.get_by_text('Page 1', exact=False)).to_be_visible()
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    assert summary_responses
    checked('Support : recherche exacte hors première page, application explicite, résultat vide, reset et résumés sans messages ni identifiants personnels')
    support_status = support.get_by_role('combobox', name='Statut des tickets support', exact=True)
    before_status = len(summary_requests)
    support_status.select_option('OPEN')
    assert len(summary_requests) == before_status, 'Le brouillon de statut ne doit pas lancer de requête'
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(20)
    assert summary_requests[-1]['variables']['status'] == 'OPEN'
    assert all(row['status'] == 'OPEN' for row in summary_responses[-1])
    open_page_one = set(row['id'] for row in summary_responses[-1])
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(17)
    assert summary_requests[-1]['variables']['offset'] == 20
    assert summary_requests[-1]['variables']['status'] == 'OPEN'
    assert open_page_one.isdisjoint(row['id'] for row in summary_responses[-1])
    expect(support.get_by_role('button', name='Suivante', exact=True)).to_be_disabled()
    support_status.select_option('RESOLVED')
    support_filter_action('Rechercher le ticket')
    expect(support.get_by_text('Page 1', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(15)
    assert summary_requests[-1]['variables']['offset'] == 0
    assert all(row['status'] == 'RESOLVED' for row in summary_responses[-1])
    support_search.fill('status-ticket-02')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(1)
    assert summary_requests[-1]['variables']['ticketId'] == 'status-ticket-02'
    assert summary_requests[-1]['variables']['status'] == 'RESOLVED'
    support_status.select_option('OPEN')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(0)
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    expect(support_status).to_have_value('ALL')
    support_status.select_option('IN_PROGRESS')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(15)
    assert all(row['status'] == 'IN_PROGRESS' for row in summary_responses[-1])
    capture(page, 'support-status-server.png')
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    checked('Support : trois statuts filtrés côté serveur, pages filtrées sans doublons, recherche combinée, résultat vide et remise à zéro')
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    support.get_by_role('button', name='Précédente', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    ticket = support.locator('aside[aria-label="Détail du ticket"]')
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    checked('Support paginé et détail serveur réel')
    mutation = 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version}}'
    # Modifier ailleurs pendant que l’admin lit version 0 : le brouillon doit échouer.
    success(page, mutation, {'id':'admin-ticket-a','v':0,'s':'IN_PROGRESS','n':'Prise en charge concurrente fictive'}, admin)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Tentative sur version périmée')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(support.get_by_text('CONCURRENT_MODIFICATION', exact=False)).to_be_visible()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_disabled()
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Résolution de recette — visible au créateur')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à RESOLVED', exact=True).click()
    expect(support.get_by_text('Statut du ticket mis à jour.', exact=True)).to_be_visible()
    expect(ticket.get_by_text('Ce ticket est résolu', exact=False)).to_be_visible()
    owner = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-a'}, fixtures['restaurantToken'])['staffSupportTicket']
    assert owner['status']=='RESOLVED' and owner['version']==2
    assert owner['history'][-1]['note']=='Résolution de recette — visible au créateur'
    capture(page, 'support-resolved.png')
    checked('conflit Support, relecture obligatoire, résolution et note visible au créateur')
    for role_token in [None, fixtures['restaurantToken'], fixtures['riderToken']]:
        denied = gql(page, '{operationsSupportTickets(limit:20,offset:0){id}}', token=role_token)
        assert denied.get('errors')
        denied = gql(page, mutation, {'id':'admin-ticket-a','v':2,'s':'RESOLVED','n':'Interdit'}, role_token)
        assert denied.get('errors')
    assert success(page, 'query($id:ID!){staffSupportTicket(id:$id){id}}', {'id':'admin-ticket-a'}, fixtures['riderToken'])['staffSupportTicket'] is None
    checked('lecture et transition Support refusées hors ADMIN, isolation du créateur')
    # Réouverture explicite : motif et confirmation, réponse acceptée mais perdue.
    reopen = ticket.get_by_role('button', name='Rouvrir en IN_PROGRESS', exact=True)
    expect(reopen).to_be_disabled()
    ticket.get_by_role('checkbox').check()
    expect(reopen).to_be_disabled()
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Réouverture fictive — problème persistant')
    expect(reopen).to_be_enabled()
    lost_reopen = {'count': 0}
    def lose_reopen(route):
        if 'transitionSupportTicket(' in (route.request.post_data or ''):
            lost_reopen['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_reopen)
    reopen.click()
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    expect(reopen).to_be_disabled()
    assert lost_reopen['count'] == 1
    page.unroute('**/api/delifast/graphql', lose_reopen)
    # Relire seulement la page ne doit pas autoriser une seconde écriture.
    support.get_by_role('button', name='Relire la page', exact=True).click()
    expect(support.get_by_role('button', name='Relire la page', exact=True)).to_be_enabled()
    expect(reopen).to_be_disabled()
    support_search.fill('admin-ticket-b')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(1)
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    expect(reopen).to_be_disabled()
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    expect(reopen).to_be_disabled()
    checked('recherche et effacement gardent le détail indépendant et ne déverrouillent pas une écriture à réponse perdue')
    support_status.select_option('RESOLVED')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(15)
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    expect(reopen).to_be_disabled()
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    expect(reopen).to_be_disabled()
    checked('filtre de statut et reset ne dévoilent pas le détail et ne réarment pas une écriture incertaine')
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    reopened = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-a'}, fixtures['restaurantToken'])['staffSupportTicket']
    assert reopened['status'] == 'IN_PROGRESS' and reopened['version'] == 3
    assert len(reopened['history']) == 4
    assert reopened['history'][-1]['note'] == 'Réouverture fictive — problème persistant'
    assert reopened['history'][-2]['note'] == 'Résolution de recette — visible au créateur'
    expect(support.get_by_role('row').filter(has=page.get_by_role('button', name='Recette support 1', exact=True)).get_by_text('IN_PROGRESS', exact=True)).to_be_visible()
    capture(page, 'support-reopened.png')
    checked('réouverture ADMIN : motif et confirmation, réponse perdue sans doublon, relecture détail obligatoire, historique et vue créateur conservés')
    support.get_by_role('button', name='Recette support 2', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_visible()
    lost_support = {'count':0}
    def lose_support(route):
        if 'transitionSupportTicket(' in (route.request.post_data or ''):
            lost_support['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_support)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Prise en charge avec réponse perdue')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    assert lost_support['count']==1
    page.unroute('**/api/delifast/graphql', lose_support)
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    accepted = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-b'}, fixtures['riderToken'])['staffSupportTicket']
    assert accepted['status']=='IN_PROGRESS' and accepted['version']==1 and len(accepted['history'])==2
    expect(support.get_by_role('row').filter(has=page.get_by_role('button', name='Recette support 2', exact=True)).get_by_text('IN_PROGRESS', exact=True)).to_be_visible()
    checked('réponse Support perdue : un seul événement, verrouillage puis relecture explicite')
    support_status.select_option('OPEN')
    support_filter_action('Rechercher le ticket')
    expect(support.locator('tbody tr')).to_have_count(20)
    support.get_by_role('button', name='Recette support 3', exact=True).click()
    expect(ticket.get_by_text('version 0', exact=False)).to_be_visible()
    success(page, mutation, {'id':'page-ticket-0','v':0,'s':'IN_PROGRESS','n':'Sortie de filtre synthétique'}, admin)
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_text('version 1', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(19)
    expect(support.get_by_role('button', name='Recette support 3', exact=True)).to_have_count(0)
    expect(support.get_by_role('button', name='Suivante', exact=True)).to_be_enabled()
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    expect(support.locator('tbody tr')).to_have_count(14)
    expect(ticket.get_by_text('Sortie de filtre synthétique', exact=False)).to_be_visible()
    support_filter_action('Effacer la recherche')
    expect(support.locator('tbody tr')).to_have_count(20)
    checked('détail sorti du filtre après modification concurrente : aucune ligne hors filtre ajoutée et page suivante encore accessible')
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement horizontal global'
    capture(page, 'admin-support-390.png')
    page.get_by_role('button', name='Commandes', exact=True).click()
    page.get_by_role('button', name='Effacer les filtres', exact=True).click()
    page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True).click()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement commandes'
    capture(page, 'admin-orders-390.png')
    page.get_by_role('button', name='Support', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    page.get_by_role('button', name='Effacer les données / quitter', exact=True).click()
    expect(page.get_by_label('Email', exact=True)).to_be_visible()
    expect(page.get_by_text('Ticket fixture admin uniquement', exact=True)).to_have_count(0)
    assert page.evaluate("sessionStorage.getItem('delifast-local-session')") is None
    capture(page, 'admin-logout.png')
    checked('petit écran 390px sans débordement global et purge à la déconnexion')
    assert not external, external
    assert not errors, errors
    assert all('availableRiders' not in query for query in all_queries), 'Aucun chargement legacy non borné dans cet admin'
    checked('aucune requête externe ni erreur JavaScript')
    Path(result_path).write_text(json.dumps({'checks':checks,'count':len(checks),'screenshots':[str(x) for x in out.glob('*.png')]}, ensure_ascii=False, indent=2)+'\n')
    browser.close()
