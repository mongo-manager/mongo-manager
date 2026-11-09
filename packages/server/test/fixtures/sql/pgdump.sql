--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;

--
-- Name: touch(); Type: FUNCTION; Schema: public; Owner: app
--

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.note := 'it''s; done';
  INSERT INTO public.orders VALUES (500);
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.touch() OWNER TO app;

CREATE FUNCTION public.tagged() RETURNS text
    LANGUAGE sql
    AS $body$ SELECT 'a;b' || $x$ ; ' $x$ $body$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: orders; Type: TABLE; Schema: public; Owner: app
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    customer character varying(100) NOT NULL,
    total numeric(10,2),
    paid boolean DEFAULT false,
    placed timestamp with time zone,
    meta jsonb,
    tags text[],
    blob bytea,
    note text
);


ALTER TABLE public.orders OWNER TO app;

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);

--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: app
--

COPY public.orders (id, customer, total, paid, placed, meta, tags, blob, note) FROM stdin;
1	Zeynep \303\207elik	99.95	t	2026-03-04 05:06:07+03	{"vip": true, "n": 1}	{a,b}	\\x01ff	line1\nline2\ttabbed
2	Bob	\N	f	2026-03-04 05:06:07.5	\N	\N	\N	back\\slash \\N
\.


CREATE TABLE public.items (
    order_id integer NOT NULL,
    sku text NOT NULL,
    qty integer,
    CONSTRAINT items_pk PRIMARY KEY (order_id, sku)
);

INSERT INTO public.items (order_id, sku, qty) VALUES (1, 'A-1', 2);
INSERT INTO public.items VALUES (1, E'B\'2\\n\x41\101', 3);
INSERT INTO public.items OVERRIDING SYSTEM VALUE VALUES (2, 'C''3\', NULL::integer);
INSERT INTO public.items VALUES (2, 'D', now());
INSERT INTO public.items VALUES (3, '{1,2}'::text, '7'::integer) ON CONFLICT DO NOTHING;

SELECT pg_catalog.setval('public.orders_id_seq', 2, true);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

CREATE INDEX orders_customer_idx ON public.orders USING btree (customer);

CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.touch();

--
-- PostgreSQL database dump complete
--

